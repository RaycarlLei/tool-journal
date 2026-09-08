// Reuse only the repository's bounded synthetic HTTP service and transport.
// Graph execution imports tool-journal from the installed npm archive instead.
export { requestReceipt, ReceiptUnavailable } from '../../dist/examples/http/client.js';
export { startSyntheticService } from '../../dist/examples/http/service.js';
