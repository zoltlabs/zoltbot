#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ZoltShortcuts, NSObject)
RCT_EXTERN_METHOD(refresh:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(takeOpenDraft:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
@end
