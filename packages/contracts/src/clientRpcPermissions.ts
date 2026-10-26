import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthFilesystemWriteScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.voiceStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.voiceSubscribe]: AuthOrchestrationOperateScope,
  [WS_METHODS.voiceStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.mineTransferPreflight]: AuthOrchestrationOperateScope,
  [WS_METHODS.mineTransferPrepare]: AuthOrchestrationOperateScope,
  [WS_METHODS.mineTransferReadChunk]: AuthOrchestrationOperateScope,
  [WS_METHODS.mineTransferBegin]: AuthOrchestrationOperateScope,
  [WS_METHODS.mineTransferWriteChunk]: AuthOrchestrationOperateScope,
  [WS_METHODS.mineTransferAccept]: AuthOrchestrationOperateScope,
  [WS_METHODS.mineTransferFinalize]: AuthOrchestrationOperateScope,
  [WS_METHODS.mineTransferCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.mineTransferGet]: AuthOrchestrationOperateScope,

  [WS_METHODS.groupsPeer]: AuthOrchestrationOperateScope,
  [WS_METHODS.groupsConnectHost]: AuthAccessWriteScope,
  [WS_METHODS.catalogExchange]: AuthAccessWriteScope,
  [WS_METHODS.catalogBindIdentity]: AuthAccessWriteScope,
  [WS_METHODS.groupsDisconnectHost]: AuthAccessWriteScope,
  [WS_METHODS.peerConfigure]: AuthAccessWriteScope,
  [WS_METHODS.peerDisable]: AuthAccessWriteScope,
  [WS_METHODS.peerApprove]: AuthAccessWriteScope,
  [WS_METHODS.peerRevoke]: AuthAccessWriteScope,
  [WS_METHODS.peerCheckDevice]: AuthAccessWriteScope,
  [WS_METHODS.peerApprovePairing]: AuthAccessWriteScope,
  [WS_METHODS.peerDenyPairing]: AuthAccessWriteScope,
  [WS_METHODS.cloudSubmit]: AuthOrchestrationOperateScope,
  [WS_METHODS.cloudLink]: AuthOrchestrationOperateScope,
  [WS_METHODS.cloudFollowUp]: AuthOrchestrationOperateScope,
  [WS_METHODS.cloudApply]: AuthFilesystemWriteScope,
  [WS_METHODS.cloudUnlink]: AuthOrchestrationOperateScope,

  [WS_METHODS.sharedGroupsGet]: AuthOrchestrationReadScope,
  [WS_METHODS.sharedGroupsSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.sharedGroupsSend]: AuthOrchestrationOperateScope,
  [WS_METHODS.sharedGroupsAddChats]: AuthOrchestrationOperateScope,
  [WS_METHODS.sharedGroupsRemoveChats]: AuthOrchestrationOperateScope,
  [WS_METHODS.sharedGroupsLeave]: AuthOrchestrationOperateScope,
  [WS_METHODS.groupsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.groupsAddMembers]: AuthOrchestrationOperateScope,
  [WS_METHODS.groupsSend]: AuthOrchestrationOperateScope,
  [WS_METHODS.groupsStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.groupsArchive]: AuthOrchestrationOperateScope,
  [WS_METHODS.groupsRetry]: AuthOrchestrationOperateScope,

  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.mineTransferPrepare || method === WS_METHODS.mineTransferReadChunk)
    return [AuthOrchestrationOperateScope, AuthFilesystemReadScope, AuthSourceControlWriteScope];
  if (
    method === WS_METHODS.mineTransferBegin ||
    method === WS_METHODS.mineTransferWriteChunk ||
    method === WS_METHODS.mineTransferAccept
  )
    return [AuthOrchestrationOperateScope, AuthFilesystemWriteScope, AuthSourceControlWriteScope];
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
