#import <Foundation/Foundation.h>
#import <MetricKit/MetricKit.h>
#import <dispatch/dispatch.h>

typedef void (*AgentreeMetricKitCallback)(const char *payload_json);

@interface AgentreeMetricKitSubscriber : NSObject <MXMetricManagerSubscriber>
@property(nonatomic, assign) AgentreeMetricKitCallback callback;
@end

@implementation AgentreeMetricKitSubscriber

- (void)didReceiveDiagnosticPayloads:(NSArray<MXDiagnosticPayload *> *)payloads {
  if (self.callback == NULL || payloads.count == 0) {
    return;
  }

  for (MXDiagnosticPayload *payload in payloads) {
    NSData *jsonData = nil;
    if ([payload respondsToSelector:@selector(JSONRepresentation)]) {
      jsonData = [payload JSONRepresentation];
    }

    if (jsonData == nil && [payload respondsToSelector:@selector(dictionaryRepresentation)]) {
      NSError *error = nil;
      jsonData = [NSJSONSerialization dataWithJSONObject:[payload dictionaryRepresentation]
                                                 options:NSJSONWritingPrettyPrinted
                                                   error:&error];
    }

    if (jsonData == nil) {
      continue;
    }

    NSString *json = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    if (json.length == 0) {
      continue;
    }

    self.callback([json UTF8String]);
  }
}

@end

static AgentreeMetricKitSubscriber *agentreeMetricKitSubscriber = nil;

int agentree_metric_kit_start(AgentreeMetricKitCallback callback) {
  if (callback == NULL) {
    return 0;
  }

  if (@available(macOS 12.0, *)) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
      agentreeMetricKitSubscriber = [AgentreeMetricKitSubscriber new];
      agentreeMetricKitSubscriber.callback = callback;
      [[MXMetricManager sharedManager] addSubscriber:agentreeMetricKitSubscriber];
    });
    return 1;
  }

  return 0;
}
