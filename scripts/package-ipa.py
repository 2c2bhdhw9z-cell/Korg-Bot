#!/usr/bin/env python3
"""Package an original Korg loader and runtime into an unmodified Discord IPA copy.

The output is unsigned and must be signed by the user's own signer. Stdlib only.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import posixpath
import stat
import struct
import tempfile
import zipfile

ARM64 = 0x100000C
LOADER_PATH = '@executable_path/Frameworks/KorgLoader.dylib'
DYLIBS = {0xC, 0x80000018, 0x8000001F, 0x20, 0x80000023}
MAGICS = {b'\xce\xfa\xed\xfe': ('<', False), b'\xcf\xfa\xed\xfe': ('<', True),
          b'\xfe\xed\xfa\xce': ('>', False), b'\xfe\xed\xfa\xcf': ('>', True)}
FATS = {b'\xca\xfe\xba\xbe': ('>', False), b'\xbe\xba\xfe\xca': ('<', False),
        b'\xca\xfe\xba\xbf': ('>', True), b'\xbf\xba\xfe\xca': ('<', True)}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def cstring(data, offset, end):
    require(0 <= offset < end <= len(data), 'Invalid string offset')
    stop = data.find(b'\0', offset, end)
    require(stop >= 0, 'Unterminated Mach-O string')
    return data[offset:stop].decode('utf-8')


def slices(data):
    if data[:4] in MAGICS:
        return [(0, len(data))]
    require(data[:4] in FATS and len(data) >= 8, 'Not a Mach-O binary')
    endian, wide = FATS[data[:4]]
    count = struct.unpack_from(endian + 'I', data, 4)[0]
    stride = 32 if wide else 20
    require(0 < count <= 64 and 8 + count * stride <= len(data), 'Invalid fat header')
    result = []
    for i in range(count):
        fields = struct.unpack_from(endian + ('IIQQII' if wide else 'IIIII'), data, 8 + i * stride)
        cpu, subtype, offset, size, align = fields[:5]
        require(align <= 31 and offset % (1 << align) == 0, 'Invalid fat alignment')
        require(offset >= 8 + count * stride and size >= 28 and offset + size <= len(data), 'Invalid fat slice')
        require(all(offset + size <= a or offset >= a + b for a, b in result), 'Overlapping fat slices')
        header = parse(data[offset:offset + size])
        require((header['cpu'], header['subtype']) == (cpu, subtype), 'Fat architecture mismatch')
        result.append((offset, size))
    return result


def parse(data):
    data = bytes(data)
    require(data[:4] in MAGICS, 'Invalid thin Mach-O magic')
    endian, wide = MAGICS[data[:4]]
    start = 32 if wide else 28
    require(len(data) >= start, 'Truncated Mach-O header')
    cpu, subtype, filetype, count, size = struct.unpack_from(endian + 'IIIII', data, 4)
    end = start + size
    require(end <= len(data) and count <= size // 8, 'Invalid load command bounds')
    commands, sections = [], []
    cursor = start
    for _ in range(count):
        require(cursor + 8 <= end, 'Truncated load command')
        cmd, length = struct.unpack_from(endian + 'II', data, cursor)
        require(length >= 8 and length % (8 if wide else 4) == 0 and cursor + length <= end, 'Invalid load command size')
        raw = data[cursor:cursor + length]
        item = {'cmd': cmd, 'raw': raw}
        if cmd in DYLIBS or cmd in (0xD, 0x8000001C):
            minimum = 12 if cmd == 0x8000001C else 24
            require(length >= minimum, 'Truncated library command')
            offset = struct.unpack_from(endian + 'I', raw, 8)[0]
            require(offset >= minimum, 'Invalid library name offset')
            item['name'] = cstring(raw, offset, length)
        if cmd in (0x21, 0x2C):
            require(length >= (24 if cmd == 0x2C else 20), 'Truncated encryption command')
            require(struct.unpack_from(endian + 'I', raw, 16)[0] == 0,
                    'Encrypted Mach-O (cryptid != 0); supply an unencrypted IPA')
        if cmd in (1, 0x19):
            segwide = cmd == 0x19
            base, stride = (72, 80) if segwide else (56, 68)
            require(length >= base, 'Truncated segment')
            nsects = struct.unpack_from(endian + 'I', raw, 64 if segwide else 48)[0]
            require(base + nsects * stride <= length, 'Truncated sections')
            fileoff, filesize = struct.unpack_from(endian + ('QQ' if segwide else 'II'), raw, 40 if segwide else 32)
            require(fileoff + filesize <= len(data), 'Segment exceeds slice')
            if filesize and fileoff:
                sections.append(fileoff)
            for i in range(nsects):
                section = base + i * stride
                offset = struct.unpack_from(endian + 'I', raw, section + (48 if segwide else 40))[0]
                flags = struct.unpack_from(endian + 'I', raw, section + (64 if segwide else 56))[0]
                extent = struct.unpack_from(endian + ('Q' if segwide else 'I'), raw, section + (40 if segwide else 36))[0]
                if extent and flags & 0xFF not in (1, 0xC, 0x12):
                    require(offset >= end and offset + extent <= len(data), 'Invalid section file bounds')
                    sections.append(offset)
        commands.append(item)
        cursor += length
    require(cursor == end, 'Load command count/size mismatch')
    return dict(endian=endian, wide=wide, cpu=cpu, subtype=subtype, filetype=filetype,
                start=start, end=end, limit=min(sections) if sections else end, commands=commands)


def dylib_command(name, endian='<'):
    encoded = name.encode('utf-8') + b'\0'
    size = (24 + len(encoded) + 7) & ~7
    return struct.pack(endian + 'IIIIII', 0xC, size, 24, 0, 0, 0) + encoded + bytes(size - 24 - len(encoded))


def rewrite(data, *, executable=False):
    result = bytearray(data)
    for offset, size in slices(data):
        chunk = data[offset:offset + size]
        header = parse(chunk)
        commands = []
        load_count = 0
        for item in header['commands']:
            cmd, name = item['cmd'], item.get('name', '')
            if cmd == 0x1D:  # LC_CODE_SIGNATURE; signature bytes remain unreferenced
                continue
            if executable and cmd in DYLIBS and name == LOADER_PATH:
                load_count += 1
                continue
            if executable and cmd in DYLIBS and is_known_old_load(name):
                continue
            commands.append(item['raw'])
        if executable:
            require(load_count <= 1, 'Duplicate Korg loader load commands')
            commands.append(dylib_command(LOADER_PATH, header['endian']))
        region = b''.join(commands)
        newend = header['start'] + len(region)
        require(newend <= header['limit'], 'Insufficient Mach-O header padding')
        if newend > header['end']:
            require(not any(chunk[header['end']:newend]), 'Header padding contains data')
        clearend = max(header['end'], newend)
        result[offset + header['start']:offset + clearend] = region + bytes(clearend - newend)
        struct.pack_into(header['endian'] + 'II', result, offset + 16, len(commands), len(region))
    return bytes(result)


def is_known_old_load(name):
    value = name.lower()
    return (value.endswith('/voicemenu.dylib') or value.endswith('/raintweak.dylib') or
            value.endswith('/libellekit.dylib') or 'bunnyresources' in value or
            'cydiasubstrate' in value or 'ellekit' in value)


def safe_name(name):
    require(name and '\\' not in name and '\0' not in name and not name.startswith('/'), 'Unsafe ZIP path')
    parts = name.rstrip('/').split('/')
    require(all(part not in ('', '.', '..') for part in parts), 'Unsafe ZIP path traversal')
    return '/'.join(parts)


def read_zip(path):
    entries, total = {}, 0
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            name = safe_name(info.filename)
            mode = info.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), 'ZIP symlink or special entry rejected')
            require(name not in entries and not info.flag_bits & 1, 'Duplicate or encrypted ZIP entry')
            total += info.file_size
            require(total <= 2 * 1024**3, 'ZIP uncompressed size exceeds 2 GiB')
            entries[name] = (info, None if info.is_dir() else archive.read(info))
    for name in entries:
        parts = PurePosixPath(name).parts
        require(not any('/'.join(parts[:i]) in entries and entries['/'.join(parts[:i])][1] is not None
                        for i in range(1, len(parts))), 'ZIP file/directory collision')
    return entries


def is_macho(data):
    return data is not None and data[:4] in (MAGICS.keys() | FATS.keys())


def verified_loader(path):
    archive = read_zip(path)
    expected_files = {'KorgLoader.dylib', 'KorgResources.bundle/korg.js',
                      'KorgResources.bundle/manifest.json', 'korg-source.tar.gz', 'SOURCE-NOTICE.md'}
    require(set(archive) == expected_files | {'manifest.json'}, 'Native archive has unexpected or missing files')
    manifest = json.loads(archive['manifest.json'][1])
    require(manifest.get('name') == 'KorgOriginalLoader' and
            manifest.get('version') == '0.2.0-native-original' and
            manifest.get('architecture') == 'arm64', 'Unexpected native manifest identity')
    require(isinstance(manifest.get('files'), dict) and set(manifest['files']) == expected_files,
            'Native manifest file list mismatch')
    for name in expected_files:
        data = archive[name][1]
        expected = manifest['files'][name]
        require(isinstance(expected, dict) and expected.get('bytes') == len(data) and
                expected.get('sha256') == sha(data), 'Native manifest checksum mismatch: ' + name)
    runtime = json.loads(archive['KorgResources.bundle/manifest.json'][1])
    require(runtime.get('name') == 'KorgOriginalRuntime' and runtime.get('version') == '0.2.0',
            'Unexpected runtime manifest identity')
    require(runtime.get('thirdPartyPluginsBundled') is False and runtime.get('runtimeDependenciesBundled') == [],
            'Runtime must not bundle third-party plugins or runtime dependencies')
    loader = archive['KorgLoader.dylib'][1]
    for offset, size in slices(loader):
        header = parse(loader[offset:offset + size])
        require(header['cpu'] == ARM64 and header['filetype'] == 6, 'Loader must be arm64 MH_DYLIB')
        for command in header['commands']:
            if command['cmd'] in DYLIBS:
                dep = command['name']
                require(dep.startswith(('/System/Library/', '/usr/lib/')) and '..' not in dep.split('/'),
                        'Loader dependency is not an Apple system library: ' + dep)
            if command['cmd'] == 0x8000001C:
                require(command['name'].startswith('@loader_path/'), 'Loader has an unsafe runpath')
    return archive, manifest


def validate_dependencies(entries, app):
    binaries = {name for name, (_, data) in entries.items() if is_macho(data)}
    containers = {}
    for name, (_, data) in entries.items():
        if name.endswith('/Info.plist') and name.rsplit('/', 1)[0].endswith(('.app', '.appex')):
            container = name.rsplit('/', 1)[0]
            executable = plistlib.loads(data).get('CFBundleExecutable')
            require(isinstance(executable, str) and '/' not in executable and executable not in ('', '.', '..'), 'Invalid bundle executable')
            containers[container] = container + '/' + executable
    system = lambda path: path.startswith(('/System/Library/', '/usr/lib/')) and '..' not in path.split('/')

    def resolve(path, binary, executable):
        if path.startswith('@loader_path/'):
            return posixpath.normpath(posixpath.dirname(binary) + '/' + path[13:])
        if path.startswith('@executable_path/'):
            return posixpath.normpath(posixpath.dirname(executable) + '/' + path[17:])
        return path

    report = {}
    for binary in sorted(binaries):
        owners = [root for root in containers if binary.startswith(root + '/')]
        require(owners, 'Mach-O outside an app container')
        executable = containers[max(owners, key=len)]
        inherited = []
        if executable in binaries:
            inherited = [c['name'] for o, n in slices(entries[executable][1])
                         for c in parse(entries[executable][1][o:o + n])['commands'] if c['cmd'] == 0x8000001C]
        commands_by_arch = []
        for o, n in slices(entries[binary][1]):
            header = parse(entries[binary][1][o:o + n])
            libs = [c['name'] for c in header['commands'] if c['cmd'] in DYLIBS]
            commands_by_arch.append({'cpu': header['cpu'], 'libraries': libs})
            paths = [(c['name'], binary) for c in header['commands'] if c['cmd'] == 0x8000001C]
            paths += [(path, executable) for path in inherited]
            for dep in libs:
                require(system(dep) or dep.startswith(('@loader_path/', '@executable_path/', '@rpath/')),
                        f'Unresolved/unsafe dependency in {binary}: {dep}')
                candidates = [resolve(dep, binary, executable)]
                if dep.startswith('@rpath/'):
                    candidates = [resolve(path, owner, executable) + '/' + dep[7:] for path, owner in paths]
                require(any(system(candidate) or (posixpath.normpath(candidate) in binaries and
                            posixpath.normpath(candidate).startswith(app + '/')) for candidate in candidates),
                        f'Unresolved/unsafe dependency in {binary}: {dep}')
        report[binary] = commands_by_arch
    return report


def package(ipa, loader_zip, output, expected_loader_sha256=None):
    ipa, loader_zip, output = Path(ipa), Path(loader_zip), Path(output)
    report_path = output.with_suffix('.inspection.json')
    require(output.resolve() != report_path.resolve() and
            all(p.resolve() not in (output.resolve(), report_path.resolve()) for p in (ipa, loader_zip)),
            'Output must not overwrite an input')
    require(not output.exists() and not report_path.exists() and not output.is_symlink() and not report_path.is_symlink(),
            'Output already exists')
    native, manifest = verified_loader(loader_zip)
    with loader_zip.open('rb') as handle:
        artifact_sha = hashlib.file_digest(handle, 'sha256').hexdigest()
    if expected_loader_sha256 is not None:
        require(artifact_sha == expected_loader_sha256, 'Native archive does not match trusted build digest')
    entries = read_zip(ipa)
    roots = {name.split('/')[1] for name in entries if name.startswith('Payload/') and len(name.split('/')) > 1}
    require(len(roots) == 1 and next(iter(roots)).endswith('.app'), 'Expected a single Payload app')
    app = 'Payload/' + next(iter(roots))
    info_name = app + '/Info.plist'
    require(info_name in entries, 'Missing app Info.plist')
    info = plistlib.loads(entries[info_name][1])
    require(info.get('CFBundleIdentifier') == 'com.hammerandchisel.discord', 'Unexpected Discord bundle identifier')
    require(str(info.get('CFBundleShortVersionString', '')).split('.')[0] == '353', 'Expected Discord version 353')
    executable_name = info.get('CFBundleExecutable')
    require(isinstance(executable_name, str) and executable_name not in ('', '.', '..') and '/' not in executable_name,
            'Invalid main executable name')
    executable = app + '/' + executable_name
    require(executable in entries, 'Missing main executable')
    original = entries[executable][1]
    require(original[:4] in MAGICS and parse(original)['wide'] and parse(original)['cpu'] == ARM64 and
            parse(original)['filetype'] == 2, 'Main executable must be thin arm64 MH_EXECUTE')

    # Inspect every app image, including known old files which will be removed.
    for name, (_, data) in entries.items():
        if name.startswith(app + '/') and is_macho(data):
            for offset, size in slices(data):
                parse(data[offset:offset + size])
    before = {name: sha(data) for name, (_, data) in entries.items() if data is not None}
    removed = sorted(name for name in entries if '_CodeSignature' in name.split('/') or
                     name.endswith('/embedded.mobileprovision') or is_known_old_file(name, app))
    for name in removed:
        del entries[name]
    changed = set(removed)

    def put(name, data, template=None, executable_mode=False):
        require(name not in entries or name in changed, 'Refusing to replace existing app resource: ' + name)
        for parent in (str(p) for p in PurePosixPath(name).parents if str(p) != '.'):
            require(parent not in entries or entries[parent][1] is None, 'Injected path collides with an existing file')
        metadata = copy.copy(template) if template else zipfile.ZipInfo(name)
        metadata.filename = name
        if template is None:
            metadata.create_system = 3
            metadata.external_attr = (stat.S_IFREG | (0o755 if executable_mode else 0o644)) << 16
        entries[name] = (metadata, data)
        changed.add(name)

    for name, (metadata, data) in list(entries.items()):
        if is_macho(data):
            patched = rewrite(data, executable=name == executable)
            if patched != data:
                changed.add(name)
                put(name, patched, metadata)
    info['CFBundleDisplayName'] = info['CFBundleName'] = 'Korg'
    changed.add(info_name)
    put(info_name, plistlib.dumps(info, fmt=plistlib.FMT_BINARY), entries[info_name][0])
    put(app + '/Frameworks/KorgLoader.dylib', rewrite(native['KorgLoader.dylib'][1]), executable_mode=True)
    for name in ('KorgResources.bundle/korg.js', 'KorgResources.bundle/manifest.json'):
        put(app + '/' + name, native[name][1])
    put(app + '/KorgResources.bundle/Source/korg-source.tar.gz', native['korg-source.tar.gz'][1])
    put(app + '/KorgResources.bundle/Source/SOURCE-NOTICE.md', native['SOURCE-NOTICE.md'][1])

    libraries = validate_dependencies(entries, app)
    require(all(name in changed or sha(data) == before[name] for name, (_, data) in entries.items()
                if data is not None and name in before), 'Original resource changed unexpectedly')
    with ipa.open('rb') as handle:
        input_sha = hashlib.file_digest(handle, 'sha256').hexdigest()
    report = dict(inputSha256=input_sha, nativeArchiveSha256=artifact_sha, nativeManifest=manifest,
                  removed=removed, modifiedOrAdded=sorted(changed - set(removed)), libraryCommands=libraries,
                  preservedBundleIdentifier=info.get('CFBundleIdentifier'),
                  preservedDiscordVersion=info.get('CFBundleShortVersionString'),
                  thirdPartyPluginsBundled=False, runtimeDependenciesBundled=[],
                  status='Unsigned; signer must sign the app, nested extensions and libraries. Physical iPhone runtime unverified.')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, suffix='.ipa', delete=False) as handle:
            temporary = Path(handle.name)
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
            for name, (metadata, data) in sorted(entries.items()):
                metadata = copy.copy(metadata)
                metadata.filename = name + ('/' if data is None else '')
                archive.writestr(metadata, b'' if data is None else data)
        with temporary.open('rb') as handle:
            report['outputSha256'] = hashlib.file_digest(handle, 'sha256').hexdigest()
        os.replace(temporary, output)
        report_path.write_text(json.dumps(report, indent=2) + '\n')
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    return report


def is_known_old_file(name, app):
    relative = name[len(app) + 1:] if name.startswith(app + '/') else ''
    lower = relative.lower()
    return (lower in ('voicemenu.dylib', 'frameworks/raintweak.dylib', 'frameworks/libellekit.dylib') or
            lower == 'bunnyresources.bundle' or lower.startswith('bunnyresources.bundle/'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ipa', required=True, type=Path)
    parser.add_argument('--loader-zip', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--expected-loader-sha256', required=True,
                        help='Trusted SHA-256 of the complete native artifact ZIP')
    args = parser.parse_args()
    try:
        report = package(args.ipa, args.loader_zip, args.output, args.expected_loader_sha256)
    except (ValueError, KeyError, OSError, struct.error, zipfile.BadZipFile) as error:
        parser.exit(1, f'Packaging refused: {error}\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
