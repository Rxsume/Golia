// src/utils/iosVersion.ts

// The iOS major version from the user agent (`OS 16_6` on iPhone, `OS 16_...` on iPad),
// or null off iOS (and on an iPad asking for the desktop site, whose UA hides the
// version). WKWebView on iPhone reports the version, which is what the performance
// defaults below are aimed at.
export const getIOSMajorVersion = (): number | null => {
    if (typeof navigator === 'undefined') return null;
    const match = /OS (\d+)_/.exec(navigator.userAgent);
    return match ? Number(match[1]) : null;
};
