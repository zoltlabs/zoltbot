// V1: reads the otpauth link out of a QR picture with the browser's own barcode reader.

interface Detected {
  rawValue: string;
}
interface BarcodeReader {
  detect(image: ImageBitmapSource): Promise<Detected[]>;
}
type BarcodeReaderClass = new (options: { formats: string[] }) => BarcodeReader;

/** The QR code's text, or undefined when the picture has none or this window can't read QR codes. */
export async function readQrPicture(file: Blob): Promise<string | undefined> {
  const Reader = (window as unknown as { BarcodeDetector?: BarcodeReaderClass }).BarcodeDetector;
  if (!Reader || file.size > 10 * 1024 * 1024) return undefined;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const found = await new Reader({ formats: ["qr_code"] }).detect(bitmap);
      return found.find((code) => code.rawValue.startsWith("otpauth://"))?.rawValue;
    } finally {
      bitmap.close();
    }
  } catch {
    return undefined;
  }
}
