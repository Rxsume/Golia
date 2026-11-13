// The QR image renderer (the `qrcode` package) ships no TypeScript types; only the call this
// file makes is declared here.
declare module 'qrcode' {
    const QRCode: {
        toDataURL(text: string, options?: Record<string, unknown>): Promise<string>;
    };
    export default QRCode;
}
