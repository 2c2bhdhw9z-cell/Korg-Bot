"""Synthetic binary/ZIP tests; no Discord binary, SDK or hook runtime needed."""
import importlib.util
import json
from pathlib import Path
import plistlib
import stat
import struct
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location('package_ipa', Path(__file__).resolve().parents[1] / 'scripts/package-ipa.py')
pkg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pkg)


def library(name, cmd=0xC):
    raw = bytearray(pkg.dylib_command(name))
    struct.pack_into('<I', raw, 0, cmd)
    return bytes(raw)


def macho(commands=(), padding=512, cryptid=0, filetype=6, symbol=None, export=False, signature=True):
    """One real file-backed section; recognizable bytes must never move."""
    segment = bytearray(152)
    struct.pack_into('<II16sQQQQIIII', segment, 0, 0x19, 152, b'__TEXT', 0, 4096, 0, 0, 7, 5, 1, 0)
    struct.pack_into('<16s16sQQIIIIIIII', segment, 72, b'__text', b'__TEXT', 0, 32, 0, 2, 0, 0, 0, 0, 0, 0)
    encryption = struct.pack('<IIIIII', 0x2C, 24, 0, 0, cryptid, 0)
    signature_command = struct.pack('<IIII', 0x1D, 16, 0, 0)
    commands = [bytes(segment), encryption, signature_command, *commands]
    if symbol is not None:
        commands.append(struct.pack('<IIIIII', 2, 24, 0, 1, 0, 0))
    if export:
        commands.append(struct.pack('<IIII', 0x80000033, 16, 0, 0))
    end = 32 + sum(map(len, commands))
    section = end + padding
    payload = b'INSTRUCTIONS MUST STAY UNCHANGED!!'
    segment = bytearray(commands[0])
    struct.pack_into('<Q', segment, 48, section + len(payload))
    struct.pack_into('<I', segment, 120, section)
    commands[0] = bytes(segment)
    trailer = b'UNREFERENCED_SIGNATURE'
    sigoff = section + len(payload)
    commands[2] = struct.pack('<IIII', 0x1D if signature else 0x7777, 16, sigoff, len(trailer))
    if symbol is not None:
        symoff = sigoff + len(trailer)
        strings = b'\0_MSHookMessageEx\0'
        commands[-1] = struct.pack('<IIIIII', 2, 24, symoff, 1, symoff + 16, len(strings))
        trailer += struct.pack('<IBBHQ', 1, symbol, 1 if symbol == 0xF else 0, 0, section) + strings
    if export:
        # root: one edge; child: terminal flags=0/address=0, no children
        edge = b'_MSHookMessageEx\0'
        trie = b'\0\1' + edge + bytes([3 + len(edge)]) + b'\x02\0\0\0'
        commands[-1] = struct.pack('<IIII', 0x80000033, 16, sigoff + len(trailer), len(trie))
        trailer += trie
    header = struct.pack('<IIIIIIII', 0xFEEDFACF, pkg.ARM64, 0, filetype, len(commands), end - 32, 0, 0)
    return header + b''.join(commands) + bytes(padding) + payload + trailer


def fat(*chunks, wide=False, endian='>'):
    stride = 32 if wide else 20
    offset = (8 + len(chunks) * stride + 7) & ~7
    header = struct.pack(endian + 'II', 0xCAFEBABF if wide else 0xCAFEBABE, len(chunks))
    records, body = [], bytearray(offset - 8 - len(chunks) * stride)
    for chunk in chunks:
        fmt = 'IIQQII' if wide else 'IIIII'
        args = (pkg.ARM64, 0, offset, len(chunk), 3)
        records.append(struct.pack(endian + fmt, *(args + (0,) if wide else args)))
        body.extend(chunk)
        padding = (-len(chunk)) % 8
        body.extend(bytes(padding))
        offset += len(chunk) + padding
    return header + b''.join(records) + body


def write_zip(path, files):
    with zipfile.ZipFile(path, 'w') as archive:
        for name, data in files.items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o755) << 16
            archive.writestr(info, data)


def native_files(loader=None):
    files = {'RainTweak.dylib': loader or macho([library('/usr/lib/libobjc.A.dylib')]),
             'BunnyResources.bundle/korg.js': b'KORG',
             'BunnyResources.bundle/nested/resource.bin': b'whole bundle',
             'korg-loader-source.tar.gz': b'exact source archive fixture',
             'LICENSE.RainTweak': b'OSL license fixture', 'NATIVE-NOTICE.md': b'notice'}
    manifest = {'name': 'KorgLoader', 'architecture': 'arm64', 'files': {
        name: {'bytes': len(data), 'sha256': pkg.sha(data)} for name, data in files.items()}}
    files['manifest.json'] = json.dumps(manifest).encode()
    return files


class MachOTests(unittest.TestCase):
    def test_insert_remove_and_leave_instructions_signature_offsets_unchanged(self):
        original = macho([library(pkg.VOICE, 0x80000018)], filetype=2)
        header = pkg.parse(original)
        patched = pkg.rewrite(original, executable=True)
        parsed = pkg.parse(patched)
        self.assertEqual(len(original), len(patched))
        self.assertEqual(original[header['limit']:], patched[header['limit']:])
        self.assertEqual([c['name'] for c in parsed['commands'] if c['cmd'] in pkg.DYLIBS], [pkg.RAIN])
        self.assertNotIn(0x1D, [c['cmd'] for c in parsed['commands']])
        self.assertEqual(struct.unpack_from('<I', pkg.dylib_command(pkg.RAIN), 8)[0], 24)
        self.assertEqual(len(pkg.dylib_command(pkg.RAIN)) % 8, 0)

    def test_insertion_without_old_load_requires_padding(self):
        # The loader-path replacement may be longer than the removed dependency.
        original = macho([library('CydiaSubstrate')], padding=0, signature=False)
        with self.assertRaisesRegex(ValueError, 'padding'):
            pkg.rewrite(original, hook=True)
        with self.assertRaisesRegex(ValueError, 'padding'):
            pkg.rewrite(macho([library(pkg.VOICE, 0x80000018)], padding=0, filetype=2, signature=False), executable=True)

    def test_encryption_rejected_in_any_slice(self):
        with self.assertRaisesRegex(ValueError, 'cryptid'):
            pkg.rewrite(macho(cryptid=1))
        with self.assertRaisesRegex(ValueError, 'cryptid'):
            pkg.rewrite(fat(macho(), macho(cryptid=1)))

    def test_fat_offsets_and_slice_lengths_preserved(self):
        for wide in (False, True):
            for endian in ('<', '>'):
                original = fat(macho(), macho(), wide=wide, endian=endian)
                patched = pkg.rewrite(original)
                self.assertEqual(pkg.slices(original), pkg.slices(patched))
                self.assertEqual(original[:pkg.slices(original)[0][0]], patched[:pkg.slices(patched)[0][0]])
                for offset, size in pkg.slices(patched):
                    header = pkg.parse(patched[offset:offset + size])
                    self.assertEqual(original[offset + header['limit']:offset + size], patched[offset + header['limit']:offset + size])
                    self.assertNotIn(0x1D, [c['cmd'] for c in header['commands']])

    def test_voice_must_be_exact_weak_single_load(self):
        for commands in ([], [library(pkg.VOICE)], [library(pkg.VOICE, 0x80000018)] * 2):
            with self.assertRaises(ValueError):
                pkg.rewrite(macho(commands, filetype=2), executable=True)

    def test_bounds_and_nonzero_header_padding(self):
        original = bytearray(macho([library(pkg.VOICE, 0x80000018)], filetype=2, signature=False))
        original[pkg.parse(original)['end']] = 1
        with self.assertRaisesRegex(ValueError, 'padding contains data'):
            pkg.rewrite(bytes(original), executable=True)
        struct.pack_into('<I', original, 36, 0xFFFFFFF8)
        with self.assertRaisesRegex(ValueError, 'command size'):
            pkg.parse(bytes(original))
        with self.assertRaisesRegex(ValueError, 'fat slice'):
            pkg.slices(fat(macho())[:-64])

    def test_hook_requires_real_export(self):
        self.assertTrue(pkg.exports_hook(macho(symbol=0xF)))
        self.assertTrue(pkg.exports_hook(macho(export=True)))
        self.assertFalse(pkg.exports_hook(macho(symbol=1)))  # undefined import
        self.assertFalse(pkg.exports_hook(macho() + b'_MSHookMessageEx\0'))


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ipa, self.loader, self.output = [self.root / name for name in ('user.ipa', 'loader.zip', 'Korg.ipa')]
        self.app = 'Payload/Discord.app/'
        self.files = {self.app + 'Info.plist': plistlib.dumps({'CFBundleExecutable': 'Discord',
            'CFBundleIdentifier': 'com.hammerandchisel.discord', 'CFBundleShortVersionString': '352.0', 'CFBundleVersion': '999'}),
            self.app + 'Discord': macho([library(pkg.VOICE, 0x80000018), library('/usr/lib/libobjc.A.dylib')], filetype=2),
            self.app + 'VoiceMenu.dylib': macho(), self.app + '_CodeSignature/CodeResources': b'signature',
            self.app + 'embedded.mobileprovision': b'profile', self.app + 'asset.bin': b'UNCHANGED',
            self.app + 'PlugIns/Share.appex/Info.plist': plistlib.dumps({'CFBundleExecutable': 'Share', 'CFBundleIdentifier': 'com.hammerandchisel.discord.Share'}),
            self.app + 'PlugIns/Share.appex/Share': macho(filetype=2),
            self.app + 'PlugIns/Share.appex/embedded.mobileprovision': b'nested profile',
            self.app + 'PlugIns/Share.appex/_CodeSignature/CodeResources': b'nested signature',
            'iTunesMetadata.plist': b'personal metadata'}
        write_zip(self.ipa, self.files)
        write_zip(self.loader, native_files())

    def test_complete_repack_preserves_resources_ids_versions_and_permissions(self):
        report = pkg.package(self.ipa, self.loader, self.output)
        entries = pkg.read_zip(self.output)
        info = plistlib.loads(entries[self.app + 'Info.plist'][1])
        self.assertEqual(info['CFBundleDisplayName'], 'Korg')
        self.assertEqual(info['CFBundleName'], 'Korg')
        self.assertEqual(info['CFBundleVersion'], '999')
        self.assertEqual(info['CFBundleIdentifier'], 'com.hammerandchisel.discord')
        self.assertEqual(info['CFBundleShortVersionString'], '352.0')
        for name in ('asset.bin', 'PlugIns/Share.appex/Info.plist'):
            self.assertEqual(entries[self.app + name][1], self.files[self.app + name])
            self.assertEqual(entries[self.app + name][0].external_attr >> 16, stat.S_IFREG | 0o755)
        self.assertTrue(all(name.startswith('Payload/') for name in entries))
        self.assertFalse(any('_CodeSignature' in name or name.endswith('embedded.mobileprovision') for name in entries))
        self.assertNotIn(self.app + 'VoiceMenu.dylib', entries)
        self.assertEqual(entries[self.app + 'BunnyResources.bundle/nested/resource.bin'][1], b'whole bundle')
        self.assertIn(self.app + 'BunnyResources.bundle/KorgDistribution/loader-source.tar.gz', entries)
        self.assertEqual(report['inputSha256'], pkg.sha(self.ipa.read_bytes()))
        self.assertEqual(report['outputSha256'], pkg.sha(self.output.read_bytes()))
        self.assertEqual(json.loads(self.output.with_suffix('.inspection.json').read_text()), report)
        self.assertIn('Unsigned', report['status'])

    def test_manifest_mismatch_and_unlisted_file(self):
        for change in ('mismatch', 'unlisted'):
            files = native_files()
            files['RainTweak.dylib' if change == 'mismatch' else 'extra'] = b'tampered'
            write_zip(self.loader, files)
            with self.assertRaisesRegex(ValueError, 'checksum|Unlisted'):
                pkg.package(self.ipa, self.loader, self.output)
            self.assertFalse(self.output.exists())

    def test_traversal_symlink_and_manifest_traversal(self):
        for name in ('../escape', '/absolute', 'Payload/../escape', 'a\\b', 'a//b'):
            write_zip(self.loader, {name: b'bad'})
            with self.assertRaisesRegex(ValueError, 'Unsafe ZIP'):
                pkg.read_zip(self.loader)
        with zipfile.ZipFile(self.loader, 'w') as archive:
            link = zipfile.ZipInfo('link')
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, '../elsewhere')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            pkg.read_zip(self.loader)
        files = native_files()
        manifest = json.loads(files['manifest.json'])
        manifest['files']['../escape'] = {'bytes': 0, 'sha256': pkg.sha(b'')}
        files['manifest.json'] = json.dumps(manifest).encode()
        write_zip(self.loader, files)
        with self.assertRaisesRegex(ValueError, 'traversal'):
            pkg.verified_loader(self.loader)

    def test_hook_supply_export_license_and_dependency_rewrite(self):
        write_zip(self.loader, native_files(macho([library('/Library/Frameworks/CydiaSubstrate.framework/CydiaSubstrate')])))
        with self.assertRaisesRegex(ValueError, 'requires --hook-runtime'):
            pkg.package(self.ipa, self.loader, self.output)
        hook, license_path = self.root / 'runtime.dylib', self.root / 'LICENSE'
        hook.write_bytes(macho(symbol=1))
        license_path.write_text('runtime license')
        with self.assertRaisesRegex(ValueError, 'does not export'):
            pkg.package(self.ipa, self.loader, self.output, hook, license_path)
        hook.write_bytes(macho(symbol=0xF))
        report = pkg.package(self.ipa, self.loader, self.output, hook, license_path)
        entries = pkg.read_zip(self.output)
        libraries = pkg.library_commands(entries[self.app + 'Frameworks/RainTweak.dylib'][1])
        self.assertEqual(libraries[0]['libraries'], ['@loader_path/libellekit.dylib'])
        self.assertIn(self.app + 'Frameworks/libellekit.dylib', entries)
        self.assertEqual(report['hookRuntime']['sha256'], pkg.sha(hook.read_bytes()))

    def test_rpath_and_local_dependencies(self):
        path = b'@executable_path/Frameworks\0'
        length = (12 + len(path) + 7) & ~7
        rpath = struct.pack('<III', 0x8000001C, length, 12) + path + bytes(length - 12 - len(path))
        self.files[self.app + 'Discord'] = macho([
            library(pkg.VOICE, 0x80000018), rpath, library('@rpath/Existing.framework/Existing')], filetype=2)
        self.files[self.app + 'Frameworks/Existing.framework/Existing'] = macho()
        write_zip(self.ipa, self.files)
        pkg.package(self.ipa, self.loader, self.output)
        self.assertTrue(self.output.exists())

    def test_unresolved_dependency_and_encrypted_nested_image_rejected(self):
        write_zip(self.loader, native_files(macho([library('@loader_path/missing.dylib')])))
        with self.assertRaisesRegex(ValueError, 'Unresolved/unsafe dependency'):
            pkg.package(self.ipa, self.loader, self.output)
        write_zip(self.loader, native_files())
        self.files[self.app + 'PlugIns/Share.appex/Share'] = macho(cryptid=1)
        write_zip(self.ipa, self.files)
        with self.assertRaisesRegex(ValueError, 'cryptid'):
            pkg.package(self.ipa, self.loader, self.output)
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
