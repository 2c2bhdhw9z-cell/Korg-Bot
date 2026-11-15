// Test harness for native/KorgLoader.mm. It builds the loader's engine-facing core (the part that compiles without
// Apple frameworks) and drives a REAL Hermes runtime through it, so the virtual-table slots, argument shapes and
// ownership rules are checked against the genuine engine instead of a hand-made imitation.
//
// The loader itself includes no React Native or Hermes header. This harness does, because it needs a runtime to
// call: use the Hermes source tag whose jsi.h matches (hermes-v250829098.0.15, jsi.h md5 5c81e771, the engine in
// Discord 353) and link its libhermesvm. See tests/native-hermes.test.mjs for the build command.
#define KORG_ABI_TEST
#include "../../native/KorgLoader.mm"

#include <dlfcn.h>
#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace jsi = facebook::jsi;
static std::vector<std::string> messages;
static int failures = 0;

#define CHECK(condition, label)                                                       \
  do {                                                                                \
    if (condition) std::printf("ok   %s\n", label);                                   \
    else { std::printf("FAIL %s   (%s:%d)\n", label, __FILE__, __LINE__); ++failures; } \
  } while (0)

static void sink(const std::string &message) { messages.push_back(message); }
static void *lookup(const char *name) { return dlsym(RTLD_DEFAULT, name); }

static std::string slurp(const char *path) {
  std::ifstream in(path, std::ios::binary);
  std::stringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

static bool any(const std::string &needle) {
  for (const auto &message : messages) if (message.find(needle) != std::string::npos) return true;
  return false;
}

int main(int argc, char **argv) {
  auto hermes = facebook::hermes::makeHermesRuntime(::hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).build());
  jsi::Runtime *real = hermes.get();
  korg::Runtime *runtime = reinterpret_cast<korg::Runtime *>(real);

  // 1. The layout check passes against the genuine engine, and its parts fail when the layout is wrong.
  CHECK(korg::checkLayout(&lookup).empty(), "checkLayout accepts the real engine's jsi::Runtime");
  if (!korg::checkLayout(&lookup).empty()) std::printf("     reason: %s\n", korg::checkLayout(&lookup).c_str());
  CHECK(!korg::checkLayout([](const char *) -> void * { return nullptr; }).empty(), "checkLayout refuses a host without the symbols");
  {
    static void *fake[120];
    for (auto &entry : fake) entry = reinterpret_cast<void *>(0x1000);
    CHECK(!korg::checkLayout([](const char *name) -> void * {
            if (std::strcmp(name, "_ZTVN8facebook3jsi7RuntimeE") == 0) return fake;
            return reinterpret_cast<void *>(0x2000);
          }).empty(), "checkLayout refuses a table whose slots do not match the exported functions");
    // The real table with one extra virtual function inserted in the middle: every later slot moves by one.
    static void *shifted[140];
    std::memcpy(shifted, lookup("_ZTVN8facebook3jsi7RuntimeE"), sizeof(void *) * (2 + korg::slot::count));
    for (size_t i = 2 + korg::slot::count; i > 2 + 60; --i) shifted[i] = shifted[i - 1];
    CHECK(!korg::checkLayout([](const char *name) -> void * {
            if (std::strcmp(name, "_ZTVN8facebook3jsi7RuntimeE") == 0) return shifted;
            return dlsym(RTLD_DEFAULT, name);
          }).empty(), "checkLayout refuses a table with one virtual function inserted (every later slot shifts)");
  }

  // 2. evaluateJavaScript really runs the script.
  korg::evaluate(runtime, "globalThis.__ran = 1 + 1;");
  CHECK(real->global().getProperty(*real, "__ran").getNumber() == 2, "slot 1 evaluates the script (globalThis.__ran === 2)");

  // 3. Negative control: the first build called slot 2. That is prepareJavaScript, which compiles and discards.
  {
    using Prepare = korg::Value (*)(korg::Runtime *, const std::shared_ptr<const korg::Input> &, const std::string &);
    std::shared_ptr<const korg::Input> input = std::make_shared<korg::Script>("globalThis.__ranViaSlot2 = true;");
    korg::Value ignored = korg::method<Prepare>(runtime, 2)(runtime, input, "korg://control");
    (void)ignored;
    CHECK(real->global().getProperty(*real, "__ranViaSlot2").isUndefined(), "slot 2 (the old, wrong slot) does NOT run the script");
  }

  // 4. A JavaScript exception surfaces as a std::exception carrying the message.
  {
    std::string what;
    try { korg::evaluate(runtime, "function inner(){ throw new Error('boom from korg'); }\ninner();"); }
    catch (const std::exception &error) { what = error.what(); }
    CHECK(what.find("boom from korg") != std::string::npos, "a thrown JavaScript Error reaches C++ with its message");
    CHECK(what.find("inner") != std::string::npos, "the exception text includes the stack");
    std::string syntax;
    try { korg::evaluate(runtime, "let = = ;"); } catch (const std::exception &error) { syntax = error.what(); }
    CHECK(!syntax.empty(), "a syntax error is reported too");
  }

  // 5. The installed native function receives JavaScript strings, and ignores bad calls without crashing.
  korg::installReporter(runtime, "__korgNativeReport", &sink);
  CHECK(real->global().getProperty(*real, "__korgNativeReport").isObject(), "the reporter is installed as a function");
  korg::evaluate(runtime, "__korgNativeReport('boot\\nhello from js'); __korgNativeReport('error\\nunicode \\u00e9\\u4e2d\\ud83d\\ude00');"
                          "__korgNativeReport(); __korgNativeReport(42); __korgNativeReport({}); __korgNativeReport(null, 1, 2);"
                          "__korgNativeReport('x'.repeat(100000));");
  CHECK(messages.size() == 3, "only string arguments are delivered (3 of 7 calls)");
  CHECK(!messages.empty() && messages[0] == "boot\nhello from js", "the first message arrives intact");
  CHECK(messages.size() > 1 && messages[1] == "error\nunicode \xc3\xa9\xe4\xb8\xad\xf0\x9f\x98\x80", "non-ASCII text arrives as UTF-8");
  CHECK(messages.size() > 2 && messages[2].size() == 100000, "a 100,000-character message arrives whole");
  messages.clear();

  // 6. Values handed back by the engine are released without crashing (strings, objects, symbols, bigints).
  for (int round = 0; round < 2000; ++round)
    korg::evaluate(runtime, "[{a:1}, 'text' + 1, Symbol('s'), 10n, function(){}, new Error('x')]");
  CHECK(true, "2000 evaluations returning object/string/symbol/bigint values survive");

  // 7. async functions work in this engine (Discord 353's), including awaiting and promise chains.
  korg::evaluate(runtime, "globalThis.__asyncDone = 0; (async () => { const v = await Promise.resolve(20); globalThis.__asyncDone = v + 22; })();");
  real->drainMicrotasks();
  CHECK(real->global().getProperty(*real, "__asyncDone").getNumber() == 42, "async/await runs to completion (42)");

  // 8. The Hermes loop-binding behavior that the runtime has to work around.
  korg::evaluate(runtime, "const probe = {}; for (const t of ['a', 'b']) probe[t] = () => t; globalThis.__loop = probe.a() + probe.b();");
  {
    std::string result = real->global().getProperty(*real, "__loop").getString(*real).utf8(*real);
    std::printf("info loop-closure probe in this engine: %s (spec says \"ab\")\n", result.c_str());
  }

  // 9. The real Korg bundle, bootstrapped exactly as the iOS loader does, then an optional scenario script.
  if (argc >= 3) {
    std::string prefix =
        "void function(){\nif(globalThis.__KORG_NATIVE__)return;\nvar report=globalThis.__korgNativeReport;\n"
        "try{delete globalThis.__korgNativeReport}catch(_){}\n"
        "Object.defineProperty(globalThis,'__KORG_NATIVE__',{value:Object.freeze({name:'KorgOriginalLoader',"
        "version:'0.2.0-native-original',abi:'jsi-0.86-apple-arm64-v2',storage:'host',report:typeof report==='function'?report:undefined,"
        "log:function(){if(globalThis.console)console.log.apply(console,arguments)}}),configurable:false,writable:false});\n";
    std::string source = prefix + slurp(argv[1]) + "\n}();\n";
    bool threw = false;
    try { korg::evaluate(runtime, source); }
    catch (const std::exception &error) { threw = true; std::printf("     bootstrap threw: %s\n", error.what()); }
    CHECK(!threw, "the Korg bundle bootstraps in the real engine without a JavaScript error");
    CHECK(any("boot\nKorg 0.2.0: core loaded"), "the runtime's first report reached native");
    CHECK(any("runtime started"), "the runtime reported that it started");
    std::string scenario = slurp(argv[2]);
    if (argc >= 4) {
      // Metro's real require polyfill (metro-runtime/src/polyfills/require.js), release mode, like Discord's bundle.
      std::string metro = "(function(){var __METRO_GLOBAL_PREFIX__='';var __DEV__=false;var global=globalThis;\n" + slurp(argv[3]) + "\n})();\n";
      try { korg::evaluate(runtime, metro, "korg://metro-require.js"); }
      catch (const std::exception &error) { std::printf("FAIL metro polyfill threw: %s\n", error.what()); ++failures; }
      CHECK(real->global().getProperty(*real, "__r").isObject(), "the real Metro polyfill defined __r (through Korg's hook)");
    }
    try { korg::evaluate(runtime, scenario, "korg://scenario.js"); }
    catch (const std::exception &error) { std::printf("FAIL scenario threw: %s\n", error.what()); ++failures; }
    for (int i = 0; i < 50; ++i) real->drainMicrotasks();
    CHECK(any("fatal probe from scenario"), "an uncaught JavaScript error reached the native side as an error report");
    CHECK(any("exploded on purpose"), "a plugin's error reached the native side as an error report");
    CHECK(any("Unhandled promise rejection: Error: unhandled promise probe"), "an unhandled promise rejection reached the native side");
    {
      bool falseAlarm = false;
      for (const auto &message : messages)
        if (message.find("handled promise probe") != std::string::npos && message.find("unhandled promise probe") == std::string::npos) falseAlarm = true;
      CHECK(!falseAlarm, "a rejection that was handled a moment later was not reported");
    }
    CHECK(any("\"phase\":\"registered\"") || any("rootWrapped\":true"), "a status snapshot saying the UI wrapped the root reached the native side");
    for (const auto &message : messages) {
      if (message.rfind("test\n", 0) == 0) {
        bool good = message.compare(5, 4, "PASS") == 0;
        std::printf("%s %s\n", good ? "ok  " : "FAIL", message.substr(5).c_str());
        if (!good) ++failures;
      }
    }
    std::printf("---- messages Korg's JavaScript sent to native ----\n");
    for (const auto &message : messages) if (message.rfind("test\n", 0) != 0) std::printf("%s\n", message.substr(0, 400).c_str());
  }

  std::printf("%s (%d failure%s)\n", failures ? "FAILED" : "ALL PASSED", failures, failures == 1 ? "" : "s");
  return failures ? 1 : 0;
}
