package expo.modules.glasses

import android.content.Context

/** Built with glasses.mockDevice=false: MockDeviceKit is not in the app. */
internal object MockSupport {
  const val AVAILABLE = false

  fun isEnabled(context: Context?): Boolean = false

  fun enable(context: Context, usePhoneCamera: Boolean): Unit =
    throw UnsupportedOperationException("MockDeviceKit is not compiled in (GLASSES_MOCK_DEVICE=false).")

  fun disable(context: Context) = Unit
}
