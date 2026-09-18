//! SPIR-V -> WGSL, with the same output the `naga` CLI produces.
//!
//! The ABI is deliberately tiny and allocation-explicit, because the caller is
//! JavaScript talking to a raw wasm instance (see web/src/naga-wgsl.ts), not a
//! wasm-bindgen glue layer:
//!
//!   ns_alloc(n)              -> ptr        caller writes the SPIR-V here
//!   ns_translate(ptr, len)   -> 0 | 1      1 = ok, 0 = failed
//!   ns_result_ptr() / _len()               the WGSL, or the error text
//!   ns_free(ptr, n)                        release an ns_alloc block
//!
//! The result buffer lives in a thread-local and is overwritten by the next
//! translate, so the caller must copy it out before calling again. That is fine
//! here: translation happens once per shader during init, and the JS side
//! copies straight into its content-hash cache.

use std::cell::RefCell;

thread_local! {
    /// Holds the WGSL on success, or the error message on failure. One slot:
    /// translation is one-shot-per-shader during init, never concurrent.
    static RESULT: RefCell<Vec<u8>> = RefCell::new(Vec::new());
}

/// Allocate `n` bytes for the caller to write into. Pair with `ns_free`.
#[no_mangle]
pub extern "C" fn ns_alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Release a block from `ns_alloc`. `n` must be the same length.
#[no_mangle]
pub extern "C" fn ns_free(p: *mut u8, n: usize) {
    if p.is_null() || n == 0 {
        return;
    }
    unsafe { drop(Vec::from_raw_parts(p, 0, n)) };
}

fn store(bytes: Vec<u8>) {
    RESULT.with(|r| *r.borrow_mut() = bytes);
}

/// Translate `len` bytes of SPIR-V at `ptr`. Returns 1 on success, 0 on
/// failure; either way the result buffer holds the text to read (WGSL, or the
/// error, which the JS side logs verbatim).
///
/// # Safety
/// `ptr` must point at `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn ns_translate(ptr: *const u8, len: usize) -> i32 {
    if ptr.is_null() || len == 0 || len % 4 != 0 {
        store(b"naga_spv: SPIR-V must be a non-empty multiple of 4 bytes".to_vec());
        return 0;
    }
    let spv = std::slice::from_raw_parts(ptr, len);

    // Match the CLI's defaults. `adjust_coordinate_space` is false there too:
    // our SPIR-V comes from DXC, which already emits the coordinate convention
    // the rest of the pipeline (and the Metal side, via SPIRV-Cross) assumes.
    let options = naga::front::spv::Options {
        adjust_coordinate_space: false,
        strict_capabilities: false,
        block_ctx_dump_prefix: None,
    };

    let module = match naga::front::spv::parse_u8_slice(spv, &options) {
        Ok(m) => m,
        Err(e) => {
            store(format!("naga_spv: SPIR-V parse failed: {e}").into_bytes());
            return 0;
        }
    };

    // WGSL output needs module info, which only validation produces. Validate
    // permissively: the CLI does the same, and our shaders legitimately use
    // capabilities a default validator rejects.
    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    );
    let info = match validator.validate(&module) {
        Ok(i) => i,
        Err(e) => {
            store(format!("naga_spv: validation failed: {e}").into_bytes());
            return 0;
        }
    };

    match naga::back::wgsl::write_string(
        &module,
        &info,
        naga::back::wgsl::WriterFlags::empty(),
    ) {
        Ok(wgsl) => {
            store(wgsl.into_bytes());
            1
        }
        Err(e) => {
            store(format!("naga_spv: WGSL emit failed: {e}").into_bytes());
            0
        }
    }
}

#[no_mangle]
pub extern "C" fn ns_result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn ns_result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}
