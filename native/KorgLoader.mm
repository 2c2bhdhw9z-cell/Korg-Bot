// Original Korg loader implementation. See ABI.md for the versioned contract.
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>

namespace korg {
// Slot-compatible interface, independently named; no React Native headers used.
class Input {
 public:
  virtual ~Input() = default;
  virtual size_t length() const = 0;
  virtual const uint8_t *bytes() const = 0;
};
class Script final : public Input {
  const std::string text_;
 public:
  explicit Script(std::string text) : text_(std::move(text)) {}
  size_t length() const override { return text_.size(); }
  const uint8_t *bytes() const override {
    return reinterpret_cast<const uint8_t *>(text_.data());
  }
};

// A nontrivial destructor is essential: Apple arm64 uses x8 for this return.
// The tag is 32 bits, then padding, then an eight-byte payload (RN 0.80).
struct Result {
  uint32_t kind;
  uint32_t padding;
  uintptr_t payload;
  ~Result() noexcept {
    // Normally undefined (0). Release an unexpected owned result as well.
    if (kind >= 4 && kind <= 7 && payload) {
      void *handle = reinterpret_cast<void *>(payload);
      auto table = *reinterpret_cast<void ***>(handle);
      reinterpret_cast<void (*)(void *) noexcept>(table[0])(handle);
    }
  }
};
static_assert(sizeof(void *) == 8 && sizeof(Result) == 16);
static_assert(offsetof(Result, payload) == 8);
static_assert(!std::is_trivially_destructible<Result>::value);
static_assert(sizeof(std::shared_ptr<const Input>) == 16);
constexpr size_t evaluateSlot = 2;
using Evaluate = Result (*)(void *, const std::shared_ptr<const Input> &,
                           const std::string &);
void evaluate(void *runtime, const std::string &source) {
  auto table = *reinterpret_cast<void ***>(runtime);
  std::shared_ptr<const Input> input = std::make_shared<Script>(source);
  const std::string url = "korg://embedded/bootstrap.js";
  auto result = reinterpret_cast<Evaluate>(table[evaluateSlot])(runtime, input, url);
  (void)result;
}
} // namespace korg

#ifndef KORG_ABI_TEST
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <mutex>

namespace {
using Initialized = void (*)(id, SEL, id, void *);
std::atomic<Initialized> previous{nullptr};
std::atomic<bool> installed{false};
std::mutex installation;

void inject(void *runtime) {
  if (!runtime) return;
  @autoreleasepool {
    NSString *file = [[[NSBundle mainBundle] bundlePath]
        stringByAppendingPathComponent:@"KorgResources.bundle/korg.js"];
    NSError *error = nil;
    NSData *data = [NSData dataWithContentsOfFile:file options:0 error:&error];
    if (!data || !data.length || data.length > 32 * 1024 * 1024) {
      NSLog(@"[Korg] Missing, empty, or oversized embedded script: %@", error);
      return;
    }
    if (![[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]) {
      NSLog(@"[Korg] Embedded script must be UTF-8 JavaScript source");
      return;
    }
    // The function body isolates local declarations; void forces undefined.
    // The runtime owns storage and UI integration through the host's modules.
    std::string source =
        "void function(){\n"
        "if(globalThis.__KORG_NATIVE__)return;\n"
        "Object.defineProperty(globalThis,'__KORG_NATIVE__',{value:Object.freeze({"
        "name:'KorgOriginalLoader',version:'0.2.0-native-original',"
        "abi:'rn-0.80-apple-arm64-v1',storage:'host',"
        "log:function(){if(globalThis.console)console.log.apply(console,arguments)}"
        "}),configurable:false,writable:false});\n";
    source.append(static_cast<const char *>(data.bytes), data.length);
    source.append("\n}();\n");
    korg::evaluate(runtime, source);
    NSLog(@"[Korg] Embedded bootstrap evaluated on the host runtime thread");
  }
}

void initialized(id host, SEL selector, id instance, void *runtime) {
  // Do not dispatch runtime work: this callback already owns the JS thread.
  // Install Metro setters before the host delegate can start its application.
  try {
    @try {
      inject(runtime);
    } @catch (NSException *error) {
      NSLog(@"[Korg] Bootstrap Objective-C exception: %@", error.reason);
    }
  } catch (const std::exception &error) {
    NSLog(@"[Korg] Bootstrap C++ exception: %s", error.what());
  } catch (...) {
    NSLog(@"[Korg] Bootstrap failed with an unknown C++ exception");
  }
  // Injection failure must not suppress the host's initialization callback.
  auto original = previous.load(std::memory_order_acquire);
  if (original) original(host, selector, instance, runtime);
}

bool compatible(Method method) {
  if (method_getNumberOfArguments(method) != 4) return false;
  char *result = method_copyReturnType(method);
  char *instance = method_copyArgumentType(method, 2);
  char *runtime = method_copyArgumentType(method, 3);
  bool valid = result && result[0] == 'v' && instance && instance[0] == '@' &&
      runtime && runtime[0] == '^';
  free(result);
  free(instance);
  free(runtime);
  return valid;
}

bool install() {
  std::lock_guard<std::mutex> lock(installation);
  if (installed.load(std::memory_order_acquire)) return true;
  Class host = objc_lookUpClass("RCTHost");
  SEL selector = sel_registerName("instance:didInitializeRuntime:");
  Method method = host ? class_getInstanceMethod(host, selector) : nullptr;
  if (!method) return false;
  if (!compatible(method)) {
    NSLog(@"[Korg] Refusing an incompatible RCTHost callback signature");
    return false;
  }
  IMP replacement = reinterpret_cast<IMP>(&initialized);
  previous.store(reinterpret_cast<Initialized>(method_getImplementation(method)),
                 std::memory_order_release);
  // Adding an override avoids changing a superclass's method when inherited.
  if (!class_addMethod(host, selector, replacement, method_getTypeEncoding(method))) {
    Method own = class_getInstanceMethod(host, selector);
    IMP displaced = method_setImplementation(own, replacement);
    previous.store(reinterpret_cast<Initialized>(displaced), std::memory_order_release);
  }
  installed.store(true, std::memory_order_release);
  NSLog(@"[Korg] Installed original RCTHost runtime observer");
  return true;
}

void retry(unsigned attempt) {
  if (install()) return;
  if (attempt == 200) {
    NSLog(@"[Korg] RCTHost unavailable after 20s; future image loads will retry");
    return;
  }
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC),
                 dispatch_get_main_queue(), ^{ retry(attempt + 1); });
}

void imageAdded(const struct mach_header *, intptr_t) {
  if (installed.load(std::memory_order_acquire)) return;
  // Never ask Objective-C to realize classes while dyld holds its image lock.
  dispatch_async(dispatch_get_main_queue(), ^{ install(); });
}

__attribute__((constructor)) void start() {
  @autoreleasepool {
    // Match the executable as well as the ID: IPA signers may change the ID.
    NSBundle *bundle = [NSBundle mainBundle];
    bool discord = [[bundle bundleIdentifier] isEqualToString:@"com.hammerandchisel.discord"] ||
        [[bundle objectForInfoDictionaryKey:@"CFBundleExecutable"] isEqualToString:@"Discord"];
    if (!discord) return;
    install();
    _dyld_register_func_for_add_image(&imageAdded);
    dispatch_async(dispatch_get_main_queue(), ^{ retry(0); });
  }
}
} // namespace
#endif