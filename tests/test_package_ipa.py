"""Synthetic Mach-O and IPA tests; no Discord binary or Apple SDK required."""
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


def macho(commands=(), padding=512, cryptid=0, filetype=6, signature=True):
    segment = bytearray(152)
    struct.pack_into('<II16sQQQQIIII', segment, 0, 0x19, 152, b'__TEXT', 0, 4096, 0, 0, 7, 5, 1, 0)
    struct.pack_into('<16s16sQQIIIIIIII', segment, 72, b'__text', b'__TEXT', 0, 32, 0, 2, 0, 0, 0, 0, 0, 0)
    encryption = struct.pack('<IIIIII', 0x2C, 24, 0, 0, cryptid, 0)
    sig = struct.pack('<IIII', 0x1D, 16, 0, 0)
    commands = [bytes(segment), encryption, sig, *commands]
    end = 32 + sum(map(len, commands))
    section = end + padding
    payload = b'INSTRUCTIONS MUST STAY UNCHANGED!!'
    segment = bytearray(commands[0])
    struct.pack_into('<Q', segment, 48, section + len(payload))
    struct.pack_into('<I', segment, 120, section)
    commands[0] = bytes(segment)
    trailer = b'UNREFERENCED_SIGNATURE'
    commands[2] = struct.pack('<IIII', 0x1D if signature else 0x7777, 16, section + len(payload), len(trailer))
    header = struct.pack('<IIIIIIII', 0xFEEDFACF, pkg.ARM64, 0, filetype, len(commands), end - 32, 0, 0)
    return header + b''.join(commands) + bytes(padding) + payload + trailer


def write_zip(path, files):
    with zipfile.ZipFile(path, 'w') as archive:
        for name, data in files.items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o755) << 16
            archive.writestr(info, data)


def native_files(loader=None):
    runtime_manifest = {'name': 'KorgOriginalRuntime', 'version': '0.2.0',
                        'thirdPartyPluginsBundled': False, 'runtimeDependenciesBundled': [],
                        'defaultPluginRegistry': []}
    files = {'KorgLoader.dylib': loader or macho([library('/usr/lib/libobjc.A.dylib')]),
             'KorgResources.bundle/korg.js': b'KORG ORIGINAL RUNTIME',
             'KorgResources.bundle/manifest.json': json.dumps(runtime_manifest).encode(),
             'korg-source.tar.gz': b'exact original source archive fixture',
             'SOURCE-NOTICE.md': b'Original Korg source notice'}
    manifest = {'name': 'KorgOriginalLoader', 'version': '0.2.0-native-original', 'architecture': 'arm64',
                'files': {name: {'bytes': len(data), 'sha256': pkg.sha(data)} for name, data in files.items()}}
    files['manifest.json'] = json.dumps(manifest).encode()
    return files


class MachOTests(unittest.TestCase):
    def test_clean_executable_gets_loader_and_signature_command_is_removed(self):
        original = macho([library('/usr/lib/libobjc.A.dylib')], filetype=2)
        header = pkg.parse(original)
        patched = pkg.rewrite(original, executable=True)
        parsed = pkg.parse(patched)
        self.assertEqual(len(original), len(patched))
        self.assertEqual(original[header['limit']:], patched[header['limit']:])
        self.assertIn(pkg.LOADER_PATH, [c['name'] for c in parsed['commands'] if c['cmd'] in pkg.DYLIBS])
        self.assertNotIn(0x1D, [c['cmd'] for c in parsed['commands']])

    def test_header_padding_and_encryption_are_checked(self):
        with self.assertRaisesRegex(ValueError, 'padding'):
            pkg.rewrite(macho(padding=0, filetype=2), executable=True)
        with self.assertRaisesRegex(ValueError, 'cryptid'):
            pkg.rewrite(macho(cryptid=1))

    def test_non_system_loader_dependencies_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'native.zip'
            write_zip(path, native_files(macho([library('@loader_path/libbad.dylib')])))
            with self.assertRaisesRegex(ValueError, 'Apple system library'):
                pkg.verified_loader(path)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ipa, self.loader, self.output = [self.root / name for name in ('discord.ipa', 'native.zip', 'Korg.ipa')]
        self.app = 'Payload/Discord.app/'
        self.files = {
            self.app + 'Info.plist': plistlib.dumps({'CFBundleExecutable': 'Discord',
                'CFBundleIdentifier': 'com.hammerandchisel.discord', 'CFBundleShortVersionString': '353.0',
                'CFBundleVersion': '122208'}),
            self.app + 'Discord': macho([library('/usr/lib/libobjc.A.dylib')], filetype=2),
            self.app + 'Frameworks/Original.framework/Original': macho(),
            self.app + 'Original.bin': b'UNCHANGED',
            self.app + '_CodeSignature/CodeResources': b'signature',
            self.app + 'embedded.mobileprovision': b'profile',
            self.app + 'PlugIns/Share.appex/Info.plist': plistlib.dumps({'CFBundleExecutable': 'Share'}),
            self.app + 'PlugIns/Share.appex/Share': macho(filetype=2),
            self.app + 'PlugIns/Share.appex/_CodeSignature/CodeResources': b'nested signature',
        }
        write_zip(self.ipa, self.files)
        write_zip(self.loader, native_files())

    def test_repackages_discord_353_and_preserves_host_dependencies(self):
        report = pkg.package(self.ipa, self.loader, self.output, pkg.sha(self.loader.read_bytes()))
        entries = pkg.read_zip(self.output)
        info = plistlib.loads(entries[self.app + 'Info.plist'][1])
        self.assertEqual(info['CFBundleDisplayName'], 'Korg')
        self.assertEqual(info['CFBundleIdentifier'], 'com.hammerandchisel.discord')
        self.assertEqual(info['CFBundleShortVersionString'], '353.0')
        self.assertEqual(info['CFBundleVersion'], '122208')
        self.assertEqual(entries[self.app + 'Original.bin'][1], b'UNCHANGED')
        self.assertIn(self.app + 'Frameworks/Original.framework/Original', entries)
        self.assertIn(self.app + 'Frameworks/KorgLoader.dylib', entries)
        self.assertIn(self.app + 'KorgResources.bundle/korg.js', entries)
        self.assertIn(self.app + 'KorgResources.bundle/manifest.json', entries)
        self.assertIn(self.app + 'KorgResources.bundle/Source/korg-source.tar.gz', entries)
        self.assertFalse(any('_CodeSignature' in name or name.endswith('embedded.mobileprovision') for name in entries))
        executable = pkg.parse(entries[self.app + 'Discord'][1])
        self.assertIn(pkg.LOADER_PATH, [c['name'] for c in executable['commands'] if c['cmd'] in pkg.DYLIBS])
        self.assertEqual(report['thirdPartyPluginsBundled'], False)
        self.assertEqual(report['runtimeDependenciesBundled'], [])
        self.assertEqual(report['preservedDiscordVersion'], '353.0')
        self.assertEqual(report['inputSha256'], pkg.sha(self.ipa.read_bytes()))
        self.assertEqual(report['outputSha256'], pkg.sha(self.output.read_bytes()))
        self.assertEqual(json.loads(self.output.with_suffix('.inspection.json').read_text()), report)

    def test_non_executable_download_sidecar_is_excluded(self):
        self.files['Payload/decrypt.day'] = b'download origin metadata'
        write_zip(self.ipa, self.files)
        report = pkg.package(self.ipa, self.loader, self.output, pkg.sha(self.loader.read_bytes()))
        self.assertNotIn('Payload/decrypt.day', pkg.read_zip(self.output))
        self.assertEqual(report['discardedSidecars'], ['Payload/decrypt.day'])

    def test_previous_known_mod_loads_and_resources_are_removed(self):
        self.files[self.app + 'Discord'] = macho([
            library('@executable_path/VoiceMenu.dylib', 0x80000018),
            library('@executable_path/Frameworks/RainTweak.dylib')], filetype=2)
        self.files[self.app + 'VoiceMenu.dylib'] = macho()
        self.files[self.app + 'Frameworks/RainTweak.dylib'] = macho()
        self.files[self.app + 'BunnyResources.bundle/korg.js'] = b'old runtime'
        write_zip(self.ipa, self.files)
        pkg.package(self.ipa, self.loader, self.output)
        entries = pkg.read_zip(self.output)
        self.assertNotIn(self.app + 'VoiceMenu.dylib', entries)
        self.assertNotIn(self.app + 'Frameworks/RainTweak.dylib', entries)
        self.assertNotIn(self.app + 'BunnyResources.bundle/korg.js', entries)
        deps = [c['name'] for c in pkg.parse(entries[self.app + 'Discord'][1])['commands'] if c['cmd'] in pkg.DYLIBS]
        self.assertEqual(deps, [pkg.LOADER_PATH])

    def test_artifact_digest_and_manifest_are_mandatory_and_verified(self):
        with self.assertRaisesRegex(ValueError, 'trusted build digest'):
            pkg.package(self.ipa, self.loader, self.output, '0' * 64)
        files = native_files()
        files['KorgLoader.dylib'] += b'tamper'
        write_zip(self.loader, files)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            pkg.package(self.ipa, self.loader, self.output)

    def test_refuses_unknown_identity_version_and_encrypted_host_image(self):
        data = plistlib.loads(self.files[self.app + 'Info.plist'])
        data['CFBundleShortVersionString'] = '352.0'
        self.files[self.app + 'Info.plist'] = plistlib.dumps(data)
        write_zip(self.ipa, self.files)
        with self.assertRaisesRegex(ValueError, 'version 353'):
            pkg.package(self.ipa, self.loader, self.output)
        data['CFBundleShortVersionString'] = '353.0'
        self.files[self.app + 'Info.plist'] = plistlib.dumps(data)
        self.files[self.app + 'PlugIns/Share.appex/Share'] = macho(cryptid=1)
        write_zip(self.ipa, self.files)
        with self.assertRaisesRegex(ValueError, 'cryptid'):
            pkg.package(self.ipa, self.loader, self.output)
        self.assertFalse(self.output.exists())

    def test_manifest_cannot_claim_plugin_or_runtime_payloads(self):
        files = native_files()
        runtime = json.loads(files['KorgResources.bundle/manifest.json'])
        runtime['thirdPartyPluginsBundled'] = True
        files['KorgResources.bundle/manifest.json'] = json.dumps(runtime).encode()
        files['manifest.json'] = json.dumps({'name': 'KorgOriginalLoader', 'version': '0.2.0-native-original',
            'architecture': 'arm64', 'files': {name: {'bytes': len(data), 'sha256': pkg.sha(data)}
                                                for name, data in files.items() if name != 'manifest.json'}}).encode()
        write_zip(self.loader, files)
        with self.assertRaisesRegex(ValueError, 'third-party plugins'):
            pkg.package(self.ipa, self.loader, self.output)


if __name__ == '__main__':
    unittest.main()
