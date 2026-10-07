//! The program's heap allocator.
//!
//! Solana's default allocator is a bump allocator that never frees and grows
//! a buffer by copying it. Decoding a definition grows several vectors as it
//! goes, so every growth leaked the old copy, and a worst-of note's
//! definition no longer fit the 32 KiB heap on the CRE report path (where a
//! transaction cannot request a bigger heap frame).
//!
//! This is still a bump allocator over the same region, but the most recent
//! allocation grows and shrinks in place, and freeing it gives the space back.
//! That is the pattern of decoding (one vector growing at a time) and of the
//! short-lived buffers the engine allocates while it runs a step.

use core::alloc::{GlobalAlloc, Layout};
use core::ptr::null_mut;

const HEAP_START: usize = 0x3_0000_0000; // MM_HEAP_START
const HEAP_LEN: usize = 32 * 1024;
/// The first word of the heap holds the current top (0 = not set yet: the heap starts zeroed).
const FIRST: usize = HEAP_START + core::mem::size_of::<usize>();

pub struct StackBump;

impl StackBump {
    #[inline]
    unsafe fn top() -> *mut usize {
        HEAP_START as *mut usize
    }
    #[inline]
    unsafe fn current() -> usize {
        let t = *Self::top();
        if t == 0 { FIRST } else { t }
    }
}

unsafe impl GlobalAlloc for StackBump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let start = (Self::current() + layout.align() - 1) & !(layout.align() - 1);
        match start.checked_add(layout.size()) {
            Some(end) if end <= HEAP_START + HEAP_LEN => {
                *Self::top() = end;
                start as *mut u8
            }
            _ => null_mut(),
        }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if ptr as usize + layout.size() == Self::current() {
            *Self::top() = ptr as usize;
        }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if ptr as usize + layout.size() == Self::current() {
            return match (ptr as usize).checked_add(new_size) {
                Some(end) if end <= HEAP_START + HEAP_LEN => {
                    *Self::top() = end;
                    ptr
                }
                _ => null_mut(),
            };
        }
        let new = self.alloc(Layout::from_size_align_unchecked(new_size, layout.align()));
        if !new.is_null() {
            core::ptr::copy_nonoverlapping(ptr, new, layout.size().min(new_size));
        }
        new
    }
}

#[cfg(all(target_os = "solana", feature = "custom-heap"))]
#[global_allocator]
static ALLOCATOR: StackBump = StackBump;
