#[cfg(target_os = "windows")]
use tauri::WebviewWindow;
#[cfg(target_os = "windows")]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{LPARAM, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
            WindowsAndMessaging::{
                DestroyIcon, LoadImageW, SendMessageW, HICON, ICON_BIG, ICON_SMALL, IMAGE_ICON,
                LR_DEFAULTCOLOR, SM_CXICON, SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
            },
        },
    },
};

#[cfg(target_os = "windows")]
const APP_ICON_RESOURCE_ID: u16 = 32512;

#[cfg(target_os = "windows")]
pub struct WindowsAppIconHandles {
    small: isize,
    big: isize,
}

#[cfg(target_os = "windows")]
unsafe impl Send for WindowsAppIconHandles {}
#[cfg(target_os = "windows")]
unsafe impl Sync for WindowsAppIconHandles {}

#[cfg(target_os = "windows")]
impl Drop for WindowsAppIconHandles {
    fn drop(&mut self) {
        unsafe {
            if self.small != 0 {
                let _ = DestroyIcon(HICON(self.small as *mut _));
            }
            if self.big != 0 {
                let _ = DestroyIcon(HICON(self.big as *mut _));
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn load_embedded_icon(width: i32, height: i32) -> Result<HICON, String> {
    let module = unsafe { GetModuleHandleW(PCWSTR::null()) }.map_err(|error| {
        format!("failed to access the SciLoom executable icon resource: {error}")
    })?;
    let handle = unsafe {
        LoadImageW(
            Some(module.into()),
            PCWSTR::from_raw(APP_ICON_RESOURCE_ID as usize as *const u16),
            IMAGE_ICON,
            width,
            height,
            LR_DEFAULTCOLOR,
        )
    }
    .map_err(|error| format!("failed to load the {width}x{height} SciLoom icon: {error}"))?;
    Ok(HICON(handle.0))
}

#[cfg(target_os = "windows")]
pub fn install(window: &WebviewWindow) -> Result<WindowsAppIconHandles, String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("failed to resolve the SciLoom window handle: {error}"))?;
    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
    let small_width = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, dpi) };
    let small_height = unsafe { GetSystemMetricsForDpi(SM_CYSMICON, dpi) };
    let big_width = unsafe { GetSystemMetricsForDpi(SM_CXICON, dpi) };
    let big_height = unsafe { GetSystemMetricsForDpi(SM_CYICON, dpi) };

    let small = load_embedded_icon(small_width, small_height)?;
    let big = match load_embedded_icon(big_width, big_height) {
        Ok(icon) => icon,
        Err(error) => {
            unsafe {
                let _ = DestroyIcon(small);
            }
            return Err(error);
        }
    };

    unsafe {
        SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_SMALL as usize)),
            Some(LPARAM(small.0 as isize)),
        );
        SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_BIG as usize)),
            Some(LPARAM(big.0 as isize)),
        );
    }

    Ok(WindowsAppIconHandles {
        small: small.0 as isize,
        big: big.0 as isize,
    })
}
