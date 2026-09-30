// wic_source.cpp — stills on Windows, over WIC (image_source.h).
//
// WIC converts straight into NON-premultiplied RGBA8, which is what web's
// copyExternalImageToTexture leaves (macOS has to un-premultiply after
// CoreGraphics; here there is nothing to undo).

#include "image_source.h"

#include <windows.h>
#include <wincodec.h>

#include <cstdio>
#include <vector>

#include "gpu/gpu_backend.h"
#include "platform/paths.h"

namespace nano_media {
namespace {

constexpr int32_t kFmtRGBA8 = 1;

template <typename T>
struct Com {
  T* p = nullptr;
  ~Com() { if (p) p->Release(); }
  T** operator&() { return &p; }
  T* operator->() const { return p; }
  explicit operator bool() const { return p != nullptr; }
};

std::string hr(const char* what, HRESULT h) {
  char buf[64];
  std::snprintf(buf, sizeof buf, " (0x%08lx)", (unsigned long)h);
  return std::string(what) + buf;
}

/// The container's name for the codec id ("image:png"), from WIC's own
/// description of the decoder.
std::string containerName(IWICBitmapDecoder* dec) {
  GUID g{};
  if (FAILED(dec->GetContainerFormat(&g))) return "image";
  if (g == GUID_ContainerFormatPng) return "image:png";
  if (g == GUID_ContainerFormatJpeg) return "image:jpeg";
  if (g == GUID_ContainerFormatGif) return "image:gif";
  if (g == GUID_ContainerFormatBmp) return "image:bmp";
  if (g == GUID_ContainerFormatTiff) return "image:tiff";
  return "image";
}

class ImageFrameSource : public FrameSource {
 public:
  bool open(const std::string& path) {
    // Whichever thread opens a clip: COM is per thread, and the pump's are
    // ours. An RPC_E_CHANGED_MODE thread is already initialised (STA), which
    // WIC is fine with, so only a real failure stops us.
    const HRESULT init = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninit = SUCCEEDED(init);
    if (FAILED(init) && init != RPC_E_CHANGED_MODE) { error_ = hr("CoInitializeEx", init); return false; }
    const bool ok = decode(path);
    if (uninit) CoUninitialize();
    return ok;
  }

  uint32_t width() const override { return w_; }
  uint32_t height() const override { return h_; }
  int frameCount() const override { return 1; }
  double fps() const override { return 0; }
  std::string codec() const override { return codec_; }
  int32_t formatCode() const override { return kFmtRGBA8; }
  const std::string& error() const override { return error_; }

  /// Decoded once at open; the pixels are immutable after, so upload() reads
  /// them from any thread.
  std::unique_ptr<DecodedFrame> prepare(int idx) override {
    if (idx != 0) { error_ = "frame index out of range"; return nullptr; }
    auto f = std::make_unique<DecodedFrame>();
    f->index = 0;
    return f;
  }
  bool upload(gpu::GPUBackend* backend, const DecodedFrame&, int32_t outTexHandle) override {
    backend->writeTexture(outTexHandle, w_, h_, pixels_.data(), (uint32_t)pixels_.size());
    return true;
  }

 private:
  bool decode(const std::string& path) {
    Com<IWICImagingFactory> factory;
    HRESULT h = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                 IID_IWICImagingFactory, reinterpret_cast<void**>(&factory));
    if (FAILED(h)) { error_ = hr("WIC factory", h); return false; }
    Com<IWICBitmapDecoder> dec;
    h = factory->CreateDecoderFromFilename(nano_paths::widen(path).c_str(), nullptr, GENERIC_READ,
                                           WICDecodeMetadataCacheOnDemand, &dec);
    if (FAILED(h)) {
      error_ = h == WINCODEC_ERR_COMPONENTNOTFOUND ? "not an image" : hr("cannot open", h);
      return false;
    }
    codec_ = containerName(dec.p);
    Com<IWICBitmapFrameDecode> frame;
    h = dec->GetFrame(0, &frame);
    if (FAILED(h)) { error_ = hr("image decode failed", h); return false; }
    UINT w = 0, ht = 0;
    frame->GetSize(&w, &ht);
    if (!w || !ht) { error_ = "image has no dimensions"; return false; }
    Com<IWICFormatConverter> conv;
    h = factory->CreateFormatConverter(&conv);
    if (FAILED(h)) { error_ = hr("format converter", h); return false; }
    h = conv->Initialize(frame.p, GUID_WICPixelFormat32bppRGBA, WICBitmapDitherTypeNone,
                         nullptr, 0.0, WICBitmapPaletteTypeCustom);
    if (FAILED(h)) { error_ = hr("convert to RGBA8", h); return false; }
    w_ = w;
    h_ = ht;
    pixels_.assign((size_t)w_ * h_ * 4, 0);
    h = conv->CopyPixels(nullptr, w_ * 4, (UINT)pixels_.size(), pixels_.data());
    if (FAILED(h)) { error_ = hr("CopyPixels", h); return false; }
    return true;
  }

  uint32_t w_ = 0, h_ = 0;
  std::string codec_;
  std::vector<uint8_t> pixels_;
  std::string error_;
};

}  // namespace

std::unique_ptr<FrameSource> openImageFrameSource(const std::string& path, std::string* error) {
  auto s = std::make_unique<ImageFrameSource>();
  if (s->open(path)) return s;
  if (error) *error = s->error();
  return nullptr;
}

}  // namespace nano_media
