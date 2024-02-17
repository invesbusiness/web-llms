import { AppConfig, ChatOptions, GenerationConfig } from "./config";
import {
  ChatInterface,
  GenerateProgressCallback,
  InitProgressCallback,
  InitProgressReport
} from "./types";
import {
  ChatCompletionRequest,
  ChatCompletion,
  ChatCompletionMessageParam,
} from "./openai_api_protocols/index";

/**
 * Message kind used by worker
 */
type RequestKind = (
  "return" | "throw" |
  "reload" | "generate" | "runtimeStatsText" |
  "interruptGenerate" | "unload" | "resetChat" |
  "initProgressCallback" | "generateProgressCallback" | "getMaxStorageBufferBindingSize" |
  "getGPUVendor" | "forwardTokensAndSample" | "chatCompletion" | "customRequest"
);

interface ReloadParams {
  localIdOrUrl: string;
  chatOpts?: ChatOptions;
  appConfig?: AppConfig
}

interface GenerateParams {
  input: string | Array<ChatCompletionMessageParam>,
  streamInterval?: number;
  genConfig?: GenerationConfig;
}

interface ResetChatParams {
  keepStats: boolean;
}

interface GenerateProgressCallbackParams {
  step: number,
  currentMessage: string;
}

interface ForwardTokensAndSampleParams {
  inputIds: Array<number>;
  curPos: number;
  isPrefill: boolean;
}

interface ChatCompletionParams {
  request: ChatCompletionRequest;
}

export interface CustomRequestParams {
  requestName: string;
  requestMessage: string;
}

type MessageContent =
  GenerateProgressCallbackParams |
  ReloadParams |
  GenerateParams |
  ResetChatParams |
  ForwardTokensAndSampleParams |
  ChatCompletionParams |
  CustomRequestParams |
  InitProgressReport |
  string |
  null |
  number |
  ChatCompletion;

/**
 * The message used in exchange between worker
 * and the main thread.
 */
export interface WorkerMessage {
  kind: RequestKind,
  uuid: string,
  content: MessageContent;
}

/**
 * Worker handler that can be used in a WebWorker
 *
 * @example
 *
 * // setup a chat worker handler that routes
 * // requests to the chat
 * const chat = new ChatModule();
 * cont handler = new ChatWorkerHandler(chat);
 * onmessage = handler.onmessage;
 */
export class ChatWorkerHandler {
  protected chat: ChatInterface;

  constructor(chat: ChatInterface) {
    this.chat = chat;
    this.chat.setInitProgressCallback((report: InitProgressReport) => {
      const msg: WorkerMessage = {
        kind: "initProgressCallback",
        uuid: "",
        content: report
      };
      postMessage(msg);
    });
  }

  async handleTask<T extends MessageContent>(uuid: string, task: () => Promise<T>) {
    try {
      const res = await task();
      const msg: WorkerMessage = {
        kind: "return",
        uuid: uuid,
        content: res
      };
      postMessage(msg);
    } catch (err) {
      const errStr = (err as object).toString();
      const msg: WorkerMessage = {
        kind: "throw",
        uuid: uuid,
        content: errStr
      };
      postMessage(msg);
    }
  }

  onmessage(event: MessageEvent) {
    const msg = event.data as WorkerMessage;
    switch (msg.kind) {
      case "reload": {
        this.handleTask(msg.uuid, async () => {
          const params = msg.content as ReloadParams;
          await this.chat.reload(params.localIdOrUrl, params.chatOpts, params.appConfig);
          return null;
        })
        return;
      }
      case "generate": {
        this.handleTask(msg.uuid, async () => {
          const params = msg.content as GenerateParams;
          const progressCallback = (step: number, currentMessage: string) => {
            const cbMessage: WorkerMessage = {
              kind: "generateProgressCallback",
              uuid: msg.uuid,
              content: {
                step: step,
                currentMessage: currentMessage
              }
            };
            postMessage(cbMessage);
          };
          return await this.chat.generate(
            params.input,
            progressCallback,
            params.streamInterval,
            params.genConfig
          );
        })
        return;
      }
      case "forwardTokensAndSample": {
        this.handleTask(msg.uuid, async () => {
          const params = msg.content as ForwardTokensAndSampleParams;
          return await this.chat.forwardTokensAndSample(params.inputIds, params.curPos, params.isPrefill);
        })
        return;
      }
      case "chatCompletion": {
        this.handleTask(msg.uuid, async () => {
          const params = msg.content as ChatCompletionParams;
          return await this.chat.chatCompletion(params.request);
        })
        return;
      }
      case "runtimeStatsText": {
        this.handleTask(msg.uuid, async () => {
          return await this.chat.runtimeStatsText();
        });
        return;
      }
      case "interruptGenerate": {
        this.handleTask(msg.uuid, async () => {
          this.chat.interruptGenerate();
          return null;
        });
        return;
      }
      case "unload": {
        this.handleTask(msg.uuid, async () => {
          await this.chat.unload();
          return null;
        });
        return;
      }
      case "resetChat": {
        this.handleTask(msg.uuid, async () => {
          const params = msg.content as ResetChatParams;
          await this.chat.resetChat(params.keepStats);
          return null;
        });
        return;
      }
      case "getMaxStorageBufferBindingSize": {
        this.handleTask(msg.uuid, async () => {
          return await this.chat.getMaxStorageBufferBindingSize();
        });
        return;
      }
      case "getGPUVendor": {
        this.handleTask(msg.uuid, async () => {
          return await this.chat.getGPUVendor();
        });
        return;
      }
      case "customRequest": {
        return;
      }
      default: {
        throw Error("Invalid kind, msg=" + msg);
      }
    }
  }
}

interface ChatWorker {
  onmessage: any,
  postMessage: (message: any) => void;
}

/**
 * A client of chat worker that exposes the chat interface
 *
 * @example
 *
 * const chat = new webllm.ChatWorkerClient(new Worker(
 *   new URL('./worker.ts', import.meta.url),
 *   {type: 'module'}
 * ));
 */
export class ChatWorkerClient implements ChatInterface {
  public worker: ChatWorker;
  private initProgressCallback?: InitProgressCallback;
  private generateCallbackRegistry = new Map<string, GenerateProgressCallback>();
  private pendingPromise = new Map<string, (msg: WorkerMessage) => void>();

  constructor(worker: any) {
    this.worker = worker;
    worker.onmessage = (event: any) => {
      this.onmessage(event);
    }
  }

  setInitProgressCallback(initProgressCallback: InitProgressCallback) {
    this.initProgressCallback = initProgressCallback;
  }

  protected getPromise<T extends MessageContent>(msg: WorkerMessage): Promise<T> {
    const uuid = msg.uuid;
    const executor = (
      resolve: (arg: T) => void,
      reject: (arg: any) => void
    ) => {
      const cb = (msg: WorkerMessage) => {
        if (msg.kind == "return") {
          resolve(msg.content as T);
        } else {
          if (msg.kind != "throw") {
            reject("Uknown msg kind " + msg.kind);
          } else {
            reject(msg.content);
          }
        }
      };
      this.pendingPromise.set(uuid, cb);
    };
    const promise = new Promise<T>(executor);
    this.worker.postMessage(msg);
    return promise;
  }

  async reload(localIdOrUrl: string, chatOpts?: ChatOptions, appConfig?: AppConfig): Promise<void> {
    const msg: WorkerMessage = {
      kind: "reload",
      uuid: crypto.randomUUID(),
      content: {
        localIdOrUrl: localIdOrUrl,
        chatOpts: chatOpts,
        appConfig: appConfig,
      }
    };
    await this.getPromise<null>(msg);
  }

  async getMaxStorageBufferBindingSize(): Promise<number> {
    const msg: WorkerMessage = {
      kind: "getMaxStorageBufferBindingSize",
      uuid: crypto.randomUUID(),
      content: null
    };
    return await this.getPromise<number>(msg);
  }

  async getGPUVendor(): Promise<string> {
    const msg: WorkerMessage = {
      kind: "getGPUVendor",
      uuid: crypto.randomUUID(),
      content: null
    };
    return await this.getPromise<string>(msg);
  }

  async generate(
    input: string | Array<ChatCompletionMessageParam>,
    progressCallback?: GenerateProgressCallback,
    streamInterval?: number,
    genConfig?: GenerationConfig,
  ): Promise<string> {
    const msg: WorkerMessage = {
      kind: "generate",
      uuid: crypto.randomUUID(),
      content: {
        input: input,
        streamInterval: streamInterval,
        genConfig: genConfig
      }
    };
    if (progressCallback !== undefined) {
      this.generateCallbackRegistry.set(msg.uuid, progressCallback);
    }
    return await this.getPromise<string>(msg);
  }

  async runtimeStatsText(): Promise<string> {
    const msg: WorkerMessage = {
      kind: "runtimeStatsText",
      uuid: crypto.randomUUID(),
      content: null
    };
    return await this.getPromise<string>(msg);
  }

  interruptGenerate(): void {
    const msg: WorkerMessage = {
      kind: "interruptGenerate",
      uuid: crypto.randomUUID(),
      content: null
    };
    this.getPromise<null>(msg);
  }

  async unload(): Promise<void> {
    const msg: WorkerMessage = {
      kind: "unload",
      uuid: crypto.randomUUID(),
      content: null
    };
    await this.getPromise<null>(msg);
  }

  async resetChat(keepStats = false): Promise<void> {
    const msg: WorkerMessage = {
      kind: "resetChat",
      uuid: crypto.randomUUID(),
      content: {
        keepStats: keepStats
      }
    };
    await this.getPromise<null>(msg);
  }

  async forwardTokensAndSample(
    inputIds: Array<number>, curPos: number, isPrefill: boolean
  ): Promise<number> {
    const msg: WorkerMessage = {
      kind: "forwardTokensAndSample",
      uuid: crypto.randomUUID(),
      content: {
        inputIds: inputIds,
        curPos: curPos,
        isPrefill: isPrefill
      }
    };
    return await this.getPromise<number>(msg);
  }

  async chatCompletion(
    request: ChatCompletionRequest
  ): Promise<ChatCompletion> {
    const msg: WorkerMessage = {
      kind: "chatCompletion",
      uuid: crypto.randomUUID(),
      content: {
        request: request,
      }
    };
    return await this.getPromise<ChatCompletion>(msg);
  }

  onmessage(event: any) {
    const msg = event.data as WorkerMessage;
    switch (msg.kind) {
      case "initProgressCallback": {
        if (this.initProgressCallback !== undefined) {
          this.initProgressCallback(msg.content as InitProgressReport);
        }
        return;
      }
      case "generateProgressCallback": {
        const params = msg.content as GenerateProgressCallbackParams;
        const cb = this.generateCallbackRegistry.get(msg.uuid);
        if (cb !== undefined) {
          cb(params.step, params.currentMessage);
        }
        return;
      }
      case "return": {
        const cb = this.pendingPromise.get(msg.uuid);
        if (cb === undefined) {
          throw Error("return from a unknown uuid msg=" + msg.uuid);
        }
        this.pendingPromise.delete(msg.uuid);
        cb(msg);
        return;
      }
      case "throw": {
        const cb = this.pendingPromise.get(msg.uuid);
        if (cb === undefined) {
          throw Error("return from a unknown uuid, msg=" + msg);
        }
        this.pendingPromise.delete(msg.uuid);
        cb(msg);
        return;
      }
      default: {
        throw Error("Unknown msg kind, msg=" + msg);
      }
    }
  }
}
