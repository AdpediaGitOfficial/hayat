/** Public surface of the exit package (WP-H): Mark as Left, bulk exit, clearance work, closing, rehire. */
export { markLeft, markLeftIn, markLeftInput, type MarkLeftInput, type MarkLeftOut, type CascadeCounts } from './markLeft'
export { previewBulkExit, confirmBulkExit, discardBulkExit, previewInput as previewExitInput, confirmInput as confirmExitInput, parseEmployeeIds, type PreviewExitOut, type ConfirmExitOut } from './bulk'
export { completeItem, markOutstanding, reopenItem, waiveItem, completeInput, outstandingInput, reopenInput, waiveInput, type ItemOut } from './items'
export { closeCase, closeInput, type CloseCaseOut } from './close'
export { reactivateStaff, rehireInput, type RehireInput, type RehireOut } from './rehire'
export { registerExitCascadeStep } from './cascade'
export { clearanceCloser } from './closer'
