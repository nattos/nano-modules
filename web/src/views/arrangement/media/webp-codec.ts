/**
 * WebP tile codec: ImageBitmap ⇄ ArrayBuffer. Runs inside the thumbnail worker
 * (OffscreenCanvas + createImageBitmap are worker-available), so the compression
 * work stays off the main thread. WebP keeps tiles ~10× smaller than raw RGBA.
 */

export async function webpEncode(bitmap: ImageBitmap, quality = 0.8): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
  return blob.arrayBuffer();
}

export async function webpDecode(bytes: ArrayBuffer): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
}
