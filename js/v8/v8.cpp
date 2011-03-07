#include "v8.h"

namespace v8 {
  namespace {
    const int KB = 1024;
    const int MB = 1024 * 1024;
    JSRuntime *gRuntime = 0;
    JSRuntime *rt() {
      if (!gRuntime) {
        gRuntime = JS_NewRuntime(64 * MB);
      }
      return gRuntime;
    }

    // TODO: call this
    void shutdown() {
      if (gRuntime)
        JS_DestroyRuntime(gRuntime);
      JS_ShutDown();
    }

    JSClass global_class = {
     "global", JSCLASS_GLOBAL_FLAGS,
     JS_PropertyStub, JS_PropertyStub, JS_PropertyStub, JS_StrictPropertyStub,
     JS_EnumerateStub, JS_ResolveStub, JS_ConvertStub, JS_FinalizeStub,
     JSCLASS_NO_OPTIONAL_MEMBERS
    };

    void reportError(JSContext *ctx, const char *message, JSErrorReport *report) {
      fprintf(stderr, "%s:%u:%s\n",
              report->filename ? report->filename : "<no filename>",
              (unsigned int) report->lineno,
              message);
    }
  }

  Context::Context()
    : mCtx(JS_NewContext(rt(), 8192))
  {
    JS_SetOptions(mCtx, JSOPTION_VAROBJFIX | JSOPTION_JIT | JSOPTION_METHODJIT);
    JS_SetVersion(mCtx, JSVERSION_LATEST);
    JS_SetErrorReporter(mCtx, reportError);
    mGlobal = JS_NewCompartmentAndGlobalObject(mCtx, &global_class, NULL);

    JS_InitStandardClasses(mCtx, mGlobal);
  }

  Context::~Context() {
    JS_DestroyContext(mCtx);
  }

  Context* Context::New() {
    return new Context;
  }

  Context::Scope::Scope(Context *) {
  }
}
