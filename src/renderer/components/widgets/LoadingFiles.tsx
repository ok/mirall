interface LoadingFilesProps {
  label: string
}

export default function LoadingFiles({ label }: LoadingFilesProps) {
  return (
    <div role="status" className="flex flex-col items-center justify-center min-h-full text-center">
      <p className="text-2xl font-headline font-bold text-accent">
        {label}
        <span aria-hidden="true" className="loading-dots">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </p>
    </div>
  )
}
