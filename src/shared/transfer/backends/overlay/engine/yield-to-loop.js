// Cede the worker's event loop for one macrotask, so a long synchronous run of work (a burst of
// buffered frames, a hash drain) cannot starve IPC, pause and cancel.
export const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0))
