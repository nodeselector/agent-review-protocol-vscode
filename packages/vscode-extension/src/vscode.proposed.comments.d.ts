declare module "vscode" {
  export interface CommentThread2 {
    range: Range | undefined;
    state?: CommentThreadState | { resolved?: CommentThreadState; applicability?: CommentThreadApplicability };
    readonly uri: Uri;
    comments: readonly Comment[];
    collapsibleState: CommentThreadCollapsibleState;
    canReply: boolean | CommentAuthorInformation;
    contextValue?: string;
    label?: string;
    dispose(): void;
    reveal?(comment?: Comment, options?: CommentThreadRevealOptions): Thenable<void>;
    hide?(): Thenable<void>;
  }

  export enum CommentThreadApplicability {
    Current = 0,
    Outdated = 1,
  }

  export interface CommentThreadRevealOptions {
    focus?: CommentThreadFocus;
  }

  export enum CommentThreadFocus {
    Reply = 1,
    Comment = 2,
  }

  export interface CommentingRanges {
    enableFileComments: boolean;
    ranges?: Range[];
  }

  export interface CommentingRangeProvider {
    readonly resourceHints?: { schemes: readonly string[] };
  }

  export interface CommentingRangeProvider2 {
    provideCommentingRanges(document: TextDocument, token: CancellationToken): ProviderResult<Range[] | CommentingRanges>;
  }

  export interface CommentController {
    createCommentThread(uri: Uri, range: Range | undefined, comments: readonly Comment[]): CommentThread | CommentThread2;
  }
}
