declare module "gifenc" {
  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: { palette?: number[][]; delay?: number; repeat?: number; transparent?: boolean; dispose?: number; first?: boolean },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  }
  export type PixelFormat = "rgb565" | "rgb444" | "rgba4444";
  const gifenc: {
    GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GIFEncoderInstance;
    quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: PixelFormat; oneBitAlpha?: boolean }): number[][];
    applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: PixelFormat): Uint8Array;
  };
  export default gifenc;
}
