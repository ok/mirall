import { forwardRef } from 'react'

/**
 * The offscreen `<input type="file">` a screen clicks to open the OS picker.
 *
 * The value is cleared on every change so that picking the same file twice in a row still fires —
 * without it the second pick is a no-op, because the input's value has not changed.
 */
const HiddenFileInput = forwardRef<HTMLInputElement, { onFiles: (files: File[]) => void }>(
  function HiddenFileInput({ onFiles }, ref) {
    return (
      <input
        ref={ref}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? [])
          if (list.length > 0) onFiles(list)
          e.target.value = ''
        }}
      />
    )
  },
)

export default HiddenFileInput
