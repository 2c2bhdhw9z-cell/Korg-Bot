#!/usr/bin/env python3
"""Repack a user-supplied, decrypted Discord 352 IPA; never sign or decrypt it.

Stdlib only. All binary edits are confined to Mach-O headers/load commands;
section offsets, instructions and existing signature blobs stay in place.
Run tests with: python3 -m unittest discover -s tests -p 'test_package_ipa.py'
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
VOICE = '@executable_path/VoiceMenu.dylib'
RAIN = '@executable_path/Frameworks/RainTweak.dylib'
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
    """Return checked (offset, size) pairs, including every fat architecture."""
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
        if cmd in DYLIBS or cmd == 0xD or cmd == 0x8000001C:
            minimum = 12 if cmd == 0x8000001C else 24
            require(length >= minimum, 'Truncated library command')
            offset = struct.unpack_from(endian + 'I', raw, 8)[0]
            require(offset >= minimum, 'Invalid library name offset')
            item['name'] = cstring(raw, offset, length)
        if cmd in (0x21, 0x2C):
            require(length >= (24 if cmd == 0x2C else 20), 'Truncated encryption command')
            require(struct.unpack_from(endian + 'I', raw, 16)[0] == 0, 'Encrypted Mach-O (cryptid != 0); supply an unencrypted IPA')
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
                if extent and flags & 0xFF not in (1, 0xC, 0x12):  # zero-fill has no file bytes
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


def rewrite(data, *, executable=False, hook=False):
    result = bytearray(data)
    for offset, size in slices(data):
        chunk = data[offset:offset + size]
        header = parse(chunk)
        commands, voices, rains = [], 0, 0
        for item in header['commands']:
            cmd, name = item['cmd'], item.get('name')
            if cmd == 0x1D:  # LC_CODE_SIGNATURE; its bytes remain unreferenced
                continue
            if executable and name == VOICE and cmd in DYLIBS:
                require(cmd == 0x80000018, 'VoiceMenu must be a weak load command')
                voices += 1
                continue
            if executable and name == RAIN and cmd in DYLIBS:
                rains += 1
            if hook and cmd in DYLIBS and name and 'CydiaSubstrate' in name:
                commands.append(dylib_command('@loader_path/libellekit.dylib', header['endian']))
            else:
                commands.append(item['raw'])
        if executable:
            require(voices == 1 and rains == 0, 'Expected exactly one weak VoiceMenu load and no existing Korg load')
            commands.append(dylib_command(RAIN, header['endian']))
        region = b''.join(commands)
        newend = header['start'] + len(region)
        require(newend <= header['limit'], 'Insufficient Mach-O header padding')
        if newend > header['end']:
            require(not any(chunk[header['end']:newend]), 'Header padding contains data')
        clearend = max(header['end'], newend)
        result[offset + header['start']:offset + clearend] = region + bytes(clearend - newend)
        struct.pack_into(header['endian'] + 'II', result, offset + 16, len(commands), len(region))
    return bytes(result)


def exports_hook(data):
    """Require an externally defined symbol in nlist or an actual export trie.

    A raw string match would also accept an undefined import or debug string.
    """
    def uleb(blob, cursor):
        value = shift = 0
        while cursor < len(blob) and shift < 64:
            byte = blob[cursor]
            cursor += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value, cursor
            shift += 7
        raise ValueError('Malformed export trie integer')

    for offset, size in slices(data):
        chunk = data[offset:offset + size]
        header = parse(chunk)
        if header['cpu'] != ARM64:
            continue
        for item in header['commands']:
            raw, cmd, endian = item['raw'], item['cmd'], header['endian']
            if cmd == 2:
                require(len(raw) >= 24, 'Truncated symbol table command')
                symoff, count, stroff, strsize = struct.unpack_from(endian + 'IIII', raw, 8)
                stride = 16 if header['wide'] else 12
                require(symoff + count * stride <= size and stroff + strsize <= size, 'Invalid symbol table bounds')
                for i in range(count):
                    entry = symoff + i * stride
                    index, kind, section = struct.unpack_from(endian + 'IBB', chunk, entry)
                    if index < strsize and kind & 0xE0 == 0 and kind & 1 and kind & 0xE == 0xE and section:
                        if cstring(chunk, stroff + index, stroff + strsize) == '_MSHookMessageEx':
                            return True
            if cmd not in (0x22, 0x80000022, 0x80000033):
                continue
            position = 40 if cmd in (0x22, 0x80000022) else 8
            require(len(raw) >= position + 8, 'Truncated export command')
            start, length = struct.unpack_from(endian + 'II', raw, position)
            require(start + length <= size, 'Invalid export trie bounds')
            blob, target = chunk[start:start + length], '_MSHookMessageEx'
            cursor, prefix, visited = 0, '', set()
            while blob:
                require(cursor not in visited and cursor < len(blob), 'Malformed export trie')
                visited.add(cursor)
                terminal, body = uleb(blob, cursor)
                require(body + terminal < len(blob), 'Truncated export trie node')
                if prefix == target and terminal:
                    flags, _ = uleb(blob, body)
                    if flags & 0x08 == 0:  # require a definition, not a re-export
                        return True
                children = body + terminal
                cursor = children + 1
                match = None
                for _ in range(blob[children]):
                    edge = cstring(blob, cursor, len(blob))
                    cursor += len(edge.encode('utf-8')) + 1
                    child, cursor = uleb(blob, cursor)
                    if target.startswith(prefix + edge):
                        match = (child, prefix + edge)
                if match is None:
                    break
                cursor, prefix = match
    return False


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
    require(all(not any('/'.join(PurePosixPath(name).parts[:i]) in entries and
                        entries['/'.join(PurePosixPath(name).parts[:i])][1] is not None
                        for i in range(1, len(PurePosixPath(name).parts))) for name in entries), 'ZIP file/directory collision')
    return entries


def verified_loader(path):
    archive = read_zip(path)
    manifests = [name for name in archive if PurePosixPath(name).name == 'manifest.json']
    require(len(manifests) == 1, 'Expected one native manifest')
    manifest_path = manifests[0]
    prefix = manifest_path[:-len('manifest.json')]
    manifest = json.loads(archive[manifest_path][1])
    require(manifest.get('name') == 'KorgLoader' and manifest.get('architecture') == 'arm64', 'Unexpected native manifest identity')
    files = manifest.get('files')
    require(isinstance(files, dict) and files, 'Missing native manifest checksums')
    verified = {}
    for name, expected in files.items():
        require(safe_name(name) == name, 'Unsafe manifest path')
        entry = archive.get(prefix + name)
        require(entry is not None and entry[1] is not None, 'Missing manifest file: ' + name)
        data = entry[1]
        require(len(data) == expected['bytes'] and sha(data) == expected['sha256'], 'Manifest checksum mismatch: ' + name)
        verified[name] = entry
    require({name for name, (_, data) in archive.items() if data is not None} ==
            {prefix + name for name in files} | {manifest_path}, 'Unlisted native artifact file')
    for name in ('RainTweak.dylib', 'BunnyResources.bundle/korg.js', 'korg-loader-source.tar.gz', 'LICENSE.RainTweak', 'NATIVE-NOTICE.md'):
        require(name in verified, 'Missing required native artifact: ' + name)
    return verified, manifest


def is_macho(data):
    return data is not None and data[:4] in (MAGICS.keys() | FATS.keys())


def library_commands(data):
    return [dict(cpu=parse(data[o:o + n])['cpu'], libraries=[c['name'] for c in parse(data[o:o + n])['commands'] if c['cmd'] in DYLIBS])
            for o, n in slices(data)]


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
            for o, n in slices(entries[executable][1]):
                inherited.extend(c['name'] for c in parse(entries[executable][1][o:o + n])['commands'] if c['cmd'] == 0x8000001C)
        report[binary] = library_commands(entries[binary][1])
        for o, n in slices(entries[binary][1]):
            header = parse(entries[binary][1][o:o + n])
            paths = [(c['name'], binary) for c in header['commands'] if c['cmd'] == 0x8000001C]
            paths += [(path, executable) for path in inherited]
            for command in header['commands']:
                if command['cmd'] not in DYLIBS:
                    continue
                dep = command['name']
                require(system(dep) or dep.startswith(('@loader_path/', '@executable_path/', '@rpath/')),
                        f'Unresolved/unsafe dependency in {binary}: {dep}')
                candidates = [resolve(dep, binary, executable)]
                if dep.startswith('@rpath/'):
                    candidates = [resolve(path, owner, executable) + '/' + dep[7:] for path, owner in paths]
                require(any(system(candidate) or (posixpath.normpath(candidate) in binaries and
                            posixpath.normpath(candidate).startswith(app + '/')) for candidate in candidates),
                        f'Unresolved/unsafe dependency in {binary}: {dep}')
    return report


def package(ipa, loader_zip, output, hook_runtime=None, hook_license=None):
    ipa, loader_zip, output = Path(ipa), Path(loader_zip), Path(output)
    report_path = output.with_suffix('.inspection.json')
    inputs = [ipa, loader_zip] + [Path(p) for p in (hook_runtime, hook_license) if p]
    require(output.resolve() != report_path.resolve() and all(p.resolve() not in (output.resolve(), report_path.resolve()) for p in inputs), 'Output must not overwrite an input')
    require(not output.exists() and not report_path.exists() and not output.is_symlink() and not report_path.is_symlink(), 'Output already exists')
    entries = read_zip(ipa)
    roots = {name.split('/')[1] for name in entries if name.startswith('Payload/') and len(name.split('/')) > 1}
    require(len(roots) == 1 and next(iter(roots)).endswith('.app'), 'Expected a single Payload app')
    app = 'Payload/' + next(iter(roots))
    info_name = app + '/Info.plist'
    require(info_name in entries, 'Missing app Info.plist')
    info = plistlib.loads(entries[info_name][1])
    require(str(info.get('CFBundleShortVersionString', '')).split('.')[0] == '352', 'Expected Discord version 352')
    executable = info.get('CFBundleExecutable')
    require(isinstance(executable, str) and executable not in ('', '.', '..') and '/' not in executable, 'Invalid main executable name')
    executable = app + '/' + executable
    require(executable in entries, 'Missing main executable')
    original = entries[executable][1]
    require(original[:4] in MAGICS and parse(original)['wide'] and parse(original)['cpu'] == ARM64 and parse(original)['filetype'] == 2, 'Main executable must be thin arm64 MH_EXECUTE')
    native, manifest = verified_loader(loader_zip)
    loader = native['RainTweak.dylib'][1]
    require(all(parse(loader[o:o + n])['cpu'] == ARM64 and parse(loader[o:o + n])['filetype'] == 6 for o, n in slices(loader)), 'Loader must be arm64 MH_DYLIB')
    substrate = any('CydiaSubstrate' in dep for arch in library_commands(loader) for dep in arch['libraries'])
    require(bool(hook_runtime) == bool(hook_license), 'Supply both --hook-runtime and --hook-license')
    require(not substrate or hook_runtime, 'CydiaSubstrate loader requires --hook-runtime and --hook-license')
    require(not hook_runtime or substrate, 'Hook supplied but loader has no CydiaSubstrate dependency')
    removed = sorted(name for name in entries if not (name == 'Payload' or name == app or name.startswith(app + '/')) or
                     '_CodeSignature' in name.split('/') or name.endswith('/embedded.mobileprovision') or name == app + '/VoiceMenu.dylib')
    require(app + '/VoiceMenu.dylib' in entries, 'Missing expected VoiceMenu.dylib file')
    # Check even binaries about to be removed; never accept encrypted slices.
    for name, (_, data) in entries.items():
        if name.startswith(app + '/') and is_macho(data):
            for offset, size in slices(data):
                parse(data[offset:offset + size])
    before = {name: sha(data) for name, (_, data) in entries.items() if data is not None}
    for name in removed:
        del entries[name]
    changed = set(removed)

    def put(name, data, template=None, executable_mode=False):
        require(name not in entries or name in changed, 'Refusing to replace existing app resource: ' + name)
        require(all(parent not in entries or entries[parent][1] is None for parent in
                    (str(p) for p in PurePosixPath(name).parents if str(p) != '.')),
                'Injected path collides with an existing file')
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
    put(app + '/Frameworks/RainTweak.dylib', rewrite(loader, hook=substrate), executable_mode=True)
    for name, (metadata, data) in native.items():
        if name.startswith('BunnyResources.bundle/'):
            put(app + '/' + name, data, metadata)
    distribution = app + '/BunnyResources.bundle/KorgDistribution/'
    for source, destination in [('korg-loader-source.tar.gz', 'loader-source.tar.gz'), ('LICENSE.RainTweak', 'LICENSE.RainTweak'), ('NATIVE-NOTICE.md', 'NATIVE-NOTICE.md')]:
        put(distribution + destination, native[source][1], native[source][0])
    put(distribution + 'manifest.json', (json.dumps(manifest, indent=2) + '\n').encode())
    hook_report = None
    if hook_runtime:
        runtime, license_data = Path(hook_runtime).read_bytes(), Path(hook_license).read_bytes()
        require(license_data.strip(), 'Hook license is empty')
        require(all(parse(runtime[o:o + n])['cpu'] == ARM64 and parse(runtime[o:o + n])['filetype'] == 6 for o, n in slices(runtime)), 'Hook must be arm64 MH_DYLIB')
        require(all(exports_hook(runtime[o:o + n]) for o, n in slices(runtime)), 'Hook runtime does not export MSHookMessageEx in every slice')
        put(app + '/Frameworks/libellekit.dylib', rewrite(runtime), executable_mode=True)
        put(distribution + 'LICENSE.hook-runtime', license_data)
        hook_report = {'sha256': sha(runtime), 'licenseSha256': sha(license_data)}
    libraries = validate_dependencies(entries, app)
    require(all(name in changed or sha(data) == before[name] for name, (_, data) in entries.items() if data is not None and name in before), 'Original resource changed unexpectedly')
    with ipa.open('rb') as handle:
        input_sha = hashlib.file_digest(handle, 'sha256').hexdigest()
    report = dict(inputSha256=input_sha, nativeManifest=manifest, hookRuntime=hook_report,
                  removed=removed, modifiedOrAdded=sorted(changed - set(removed)), libraryCommands=libraries,
                  preservedBundleIdentifier=info.get('CFBundleIdentifier'),
                  status='Unsigned; signer must sign app, nested extensions and libraries and manage entitlements/App Groups. Physical iPhone runtime unverified.')
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('ipa', 'loader-zip', 'output'):
        parser.add_argument('--' + flag, required=True, type=Path)
    parser.add_argument('--hook-runtime', type=Path)
    parser.add_argument('--hook-license', type=Path)
    parser.add_argument('--expected-loader-sha256', default='c34975ebac1e1465eaa85f37a40f029fe7075de0cc12c65aba4a8304d0e0a3c3',
                        help='Trusted SHA-256 of the Korg 0.2 native artifact; defaults to the verified GitHub build')
    args = parser.parse_args()
    try:
        require(sha(args.loader_zip.read_bytes()) == args.expected_loader_sha256, 'Native archive does not match trusted build digest')
        report = package(args.ipa, args.loader_zip, args.output, args.hook_runtime, args.hook_license)
    except (ValueError, KeyError, OSError, struct.error, zipfile.BadZipFile) as error:
        parser.exit(1, f'Packaging refused: {error}\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
