// macOS dialogs for the ProMatch effect: Change LUT's file picker and the
// message boxes. See mac_ui.h.
//
// Premiere calls USER_CHANGED_PARAM on the main thread, so the panels can run
// modally right here; if that ever changes, hop to the main queue and wait.

#import <AppKit/AppKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#include "mac_ui.h"

namespace pm_mac {

template <typename F>
static void OnMain(F&& f) {
    if ([NSThread isMainThread]) {
        f();
    } else {
        auto* fn = &f;
        dispatch_sync(dispatch_get_main_queue(), ^{ (*fn)(); });
    }
}

std::string PickCube(const std::string& folder) {
    std::string out;
    OnMain([&] {
        @autoreleasepool {
            NSOpenPanel* panel = [NSOpenPanel openPanel];
            panel.title = @"ProMatch: choose a LUT";
            panel.message = @"Choose a .cube LUT to store in this ProMatch effect.";
            panel.canChooseFiles = YES;
            panel.canChooseDirectories = NO;
            panel.allowsMultipleSelection = NO;
            UTType* cube = [UTType typeWithFilenameExtension:@"cube"];
            if (cube) panel.allowedContentTypes = @[ cube ];
            if (!folder.empty()) {
                NSString* dir = [NSString stringWithUTF8String:folder.c_str()];
                if (dir) panel.directoryURL = [NSURL fileURLWithPath:dir isDirectory:YES];
            }
            if ([panel runModal] == NSModalResponseOK && panel.URL.fileSystemRepresentation) {
                out = panel.URL.fileSystemRepresentation;
            }
        }
    });
    return out;
}

void Alert(const std::string& message, bool warning) {
    OnMain([&] {
        @autoreleasepool {
            NSAlert* alert = [[NSAlert alloc] init];
            alert.messageText = @"ProMatch";
            alert.informativeText = [NSString stringWithUTF8String:message.c_str()] ?: @"";
            alert.alertStyle = warning ? NSAlertStyleWarning : NSAlertStyleInformational;
            [alert addButtonWithTitle:@"OK"];
            [alert runModal];
        }
    });
}

}  // namespace pm_mac
