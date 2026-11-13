// SPDX-License-Identifier: MPL-2.0
// Exact replacements for RainTweak c2fa89a; fail closed on upstream changes.
import { replaceOnce } from "../scripts/patches.mjs";

function edits(source, changes) {
    for (const [before, after, label] of changes) source = replaceOnce(source, before, after, label);
    return source;
}

export function patchMakefile(source) {
    if (source.includes("KorgPayload/")) throw new Error("Upstream changed: loader payload already patched");
    return edits(source, [
        ['BunnyResources_RESOURCE_DIRS = Resources\n', 'BunnyResources_RESOURCE_DIRS = Resources\nBunnyResources_RESOURCE_FILES = KorgPayload/korg.js KorgPayload/LICENSE.rain KorgPayload/LICENSE.RainTweak KorgPayload/NOTICE.md KorgPayload/THIRD_PARTY_NOTICES.md KorgPayload/korg-source.tar.gz\n', "Theos bundle payload files"],
    ]);
}

export function patchControl(source) {
    return edits(source, [
        ["Package: dev.raincord.tweak", "Package: app.korg.loader", "package id"],
        ["Name: RainTweak", "Name: KorgLoader", "package name"],
        ["Version: 1.2.0", "Version: 0.2.0", "package version"],
        ["Description: A tweak to inject Rain into Discord", "Description: Bundled Korg for Discord, based on RainTweak", "package description"],
        ["Icon: <https://codeberg.org/raincord/rain/raw/branch/main/src/assets/rain.png>\n", "", "old package icon"],
    ]);
}

export function patchFilter(source) {
    return replaceOnce(source, '{ Filter = { Bundles = ( "com.hammerandchisel.discord" ); }; }', '{ Filter = { Bundles = ( "com.hammerandchisel.discord", "app.korg.discord" ); }; }', "Discord bundle filter");
}

export function patchConfig(source) {
    const old = '[NSURL URLWithString:@"http://localhost:4040/Rain.js"]';
    const count = source.split(old).length - 1;
    if (count !== 2) throw new Error("Upstream changed: expected exactly two default custom URLs");
    source = source.replaceAll(old, "nil");
    source = replaceOnce(source, 'if (urlString) {\n                    self.customLoadUrl', 'if ([urlString isKindOfClass:[NSString class]] && [urlString length] > 0) {\n                    self.customLoadUrl', "load config empty URL");
    source = replaceOnce(source, 'if (urlString) {\n                    config.customLoadUrl', 'if ([urlString isKindOfClass:[NSString class]] && [urlString length] > 0) {\n                    config.customLoadUrl', "get config empty URL");
    return replaceOnce(source, 'self.customLoadUrl.absoluteString}', 'self.customLoadUrl.absoluteString ?: @""}', "nullable custom URL persistence");
}

export function patchUtils(source) {
    return edits(source, [
        ['    config.customLoadUrl        = [NSURL URLWithString:@"http://localhost:4040/Rain.js"];', '    config.customLoadUrl        = nil;', "reset URL"],
        ['    config.customLoadUrl        = url;\n    [config saveConfig];\n    removeCachedBundle();\n    gracefulExit(presenter);', '    config.customLoadUrl        = url;\n    if (![config saveConfig]) {\n        showErrorAlert(@"Korg", @"Could not save the custom bundle setting.", nil);\n        return;\n    }\n    removeCachedBundle();\n    gracefulExit(presenter);', "custom URL save"],
        ['    config.customLoadUrlEnabled = NO;\n    config.customLoadUrl        = nil;\n    [config saveConfig];', '    config.customLoadUrlEnabled = NO;\n    config.customLoadUrl        = nil;\n    if (![config saveConfig]) {\n        showErrorAlert(@"Korg", @"Could not reset the bundle setting.", nil);\n        return;\n    }', "reset save"],
        ['void refetchBundle(UIViewController *presenter) {\n    moveCachedBundleToBackup();\n    reloadApp(presenter);\n}', 'void refetchBundle(UIViewController *presenter) {\n    removeCachedBundle();\n    reloadApp(presenter);\n}', "restore bundled Korg action"],
    ]);
}

export function patchSettings(source) {
    return edits(source, [
        ['@"RainTweak v%@ Recovery Menu"', '@"Korg v%@ Recovery Menu"', "recovery title"],
        ['@"Refetch Bundle"', '@"Reload Korg"', "refetch label"],
        ['@"Switch Bundle Version"', '@"Use Bundled Korg"', "switch version label"],
        ['        showBundleSelector(self);\n        return;', '        resetCustomBundleURL(self);\n        return;', "prevent remote version selector"],
        ['@"Reset Bundle"', '@"Reset to Bundled Korg"', "reset label"],
        ['            actionText = @"refetch the bundle";', '            actionText = @"reload Korg";', "reload confirmation"],
        ['            actionText = @"reset the bundle";', '            actionText = @"reset to bundled Korg";', "reset confirmation"],
        ['if (![url.scheme isEqualToString:@"http"] &&\n                        ![url.scheme isEqualToString:@"https"])', 'if (![url.scheme isEqualToString:@"https"])', "HTTPS custom URL only"],
        ['@"URL must start with http:// or https://"', '@"URL must start with https://"', "HTTPS error"],
        ['                                NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;', '                                if (![response isKindOfClass:[NSHTTPURLResponse class]] || ![response.URL.scheme isEqualToString:@"https"]) {\n                                    [self presentViewController:alert animated:YES completion:nil];\n                                    showErrorAlert(@"Error", @"Custom bundle must remain on HTTPS after redirects.", nil);\n                                    return;\n                                }\n                                NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *)response;', "reject insecure preflight redirects"],
        ['@"https://codeberg.org/raincord/RainTweak/issues/new?title=%@&body=%@"', '@"https://github.com/2c2bhdhw9z-cell/Korg-Bot/issues/new?title=%@&body=%@"', "project issue link"],
    ]);
}

export function patchTweak(source) {
    return edits(source, [
        ['    return [NSURL URLWithString:@"https://codeberg.org/raincord/rain/releases/download/latest/rain.98.hbc"];', '    return nil; // No network fallback: the default is packaged Korg.', "remote Rain fallback"],
        ['    if (!targetURL) return;', '    if (!targetURL || ![targetURL.scheme isEqualToString:@"https"] || !targetURL.host) return;', "custom HTTPS gate"],
        ['            if (http.statusCode == 200 && data.length > 0)', '            if (http.statusCode == 200 && data.length > 0 && [http.URL.scheme isEqualToString:@"https"])', "reject insecure bundle redirects"],
        ['    if (fresh.customLoadUrlEnabled && fresh.customLoadUrl)', '    if (fresh.customLoadUrlEnabled && [fresh.customLoadUrl.scheme isEqualToString:@"https"] && fresh.customLoadUrl.host)', "reject persisted non-HTTPS URL"],
        ['        loaderObj.setProperty(runtime, "hasThemeSupport", true);', '        loaderObj.setProperty(runtime, "hasThemeSupport", true);\n        loaderObj.setProperty(runtime, "korgEmbedded", true);', "embedded bundle flag"],
        ['    NSURL *bundleFileURL = [rainDir URLByAppendingPathComponent:@"bundle.js"];\n    NSData *bundle = [NSData dataWithContentsOfURL:bundleFileURL];\n\n    if (bundle && bundle.length > 0)\n    {\n        [JSI evaluate:bundle tag:@"rain:bundle" runtime:runtime];\n        executePreloads(runtime, rainDir);\n    }\n    else\n    {\n        downloadBundleForNextLaunch(rainDir);\n    }',
            '    NSData *bundle = nil;\n    if (loaderConfig.customLoadUrlEnabled && resolveDownloadURL()) {\n        NSURL *cached = [rainDir URLByAppendingPathComponent:@"bundle.js"];\n        bundle = [NSData dataWithContentsOfURL:cached];\n        if (!bundle.length) downloadBundleForNextLaunch(rainDir);\n    } else {\n        NSString *resource = [bunnyPatchesBundlePath stringByAppendingPathComponent:@"korg.js"];\n        bundle = [NSData dataWithContentsOfFile:resource];\n        if (!bundle.length) {\n            BunnyLog(@"Korg bundled resource missing or empty at %@; Discord will continue without Korg", resource);\n            showErrorAlert(@"Korg unavailable", @"Bundled korg.js is missing. Reinstall Korg; Discord will continue normally.", nil);\n        }\n    }\n    if (bundle.length) {\n        [JSI evaluate:bundle tag:@"korg:bundle" runtime:runtime];\n        executePreloads(runtime, rainDir);\n    }', "runtime packaged Korg fallback"],
    ]);
}

export function patchPayloadTemplate(source) {
    if (source.includes("korgEmbedded")) throw new Error("Upstream changed: metadata already patched");
    return replaceOnce(source, '    hasThemeSupport: true,', '    hasThemeSupport: true,\n    korgEmbedded: true,', "generated metadata flag");
}

export const nativeEdits = [
    ["Makefile", patchMakefile],
    ["control", patchControl],
    ["RainTweak.plist", patchFilter],
    ["Sources/LoaderConfig.m", patchConfig],
    ["Sources/Utils.m", patchUtils],
    ["Sources/Settings.m", patchSettings],
    ["Sources/Tweak.xm", patchTweak],
    ["Sources/payload-base.template.js", patchPayloadTemplate],
];
