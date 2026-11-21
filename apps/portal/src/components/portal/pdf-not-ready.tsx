export const PDF_PREPARING = 'The PDF copy is being prepared.';
export const PDF_DELAYED = 'This PDF is delayed. Our team has been told.';

/**
 * Stands in for the PDF while a document has no file. `failed` is the server's `renderFailed`: the copy
 * could not be made and staff were told, so it says so plainly, with no codes and no retry.
 */
export function PdfNotReady({
  failed,
  className,
}: {
  failed?: boolean;
  className?: string | undefined;
}) {
  return <p className={className}>{failed ? PDF_DELAYED : PDF_PREPARING}</p>;
}
