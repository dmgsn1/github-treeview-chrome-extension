// The build both halves of the extension were loaded from. Chrome reloads the
// side panel's files whenever it reopens, but keeps running an unpacked
// extension's service worker until the extension is reloaded, so after an
// update the two can disagree. The panel compares this with what the worker
// reports and offers a reload. Keep it equal to manifest.json's "version".
export const BUILD = "0.6.0";

/**
 * What is wrong with the service worker, from its answer to a ping:
 * null when it runs this build, otherwise a sentence for the panel.
 */
export function workerProblem(reply, build = BUILD) {
  if (!reply?.ok) return "The extension's background part is not answering, so new tabs are not gathered and the lists do not load.";
  if (reply.result?.build !== build) return "The extension's background part is still running an older version, so it does not do what this panel expects.";
  return null;
}
