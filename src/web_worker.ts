import {
  AppConfig,
  ChatOptions,
  EngineConfig,
  GenerationConfig,
} from "./config";
import {
  EngineInterface,
  GenerateProgressCallback,
  InitProgressCallback,
  InitProgressReport,
} from "./types";
import {
  ChatCompletionRequest,
  ChatCompletionRequestBase,
  ChatCompletionRequestStreaming,
  ChatCompletionRequestNonStreaming,
  ChatCompletion,
  ChatCompletionChunk,
} from "./openai_api_protocols/index";
import * as API from "./openai_api_protocols/apis";
import {
  MessageContent,
  ReloadParams,
  GenerateParams,
  ForwardTokensAndSampleParams,
  ChatCompletionNonStreamingParams,
  ChatCompletionStreamInitParams,
  ResetChatParams,
  GenerateProgressCallbackParams,
  WorkerResponse,
  WorkerRequest,
} from "./message";

export interface PostMessageHandler {
  postMessage: (message: any) => void;
}

/**
 * Worker handler that can be used in a WebWorker
 *
 * @example
 *
 * // setup a chat worker handler that routes
 * // requests to the chat
 * const engine = new Engine();
 * cont handler = new EngineWorkerHandler(engine);
 * onmessage = handler.onmessage;
 */
export class EngineWorkerHandler {
  protected engine: EngineInterface;
  protected chatCompletionAsyncChunkGenerator?: AsyncGenerator<
    ChatCompletionChunk,
    void,
    void
  >;
  protected postMessageHandler?: PostMessageHandler;

  /**
   * @param engine A concrete implementation of EngineInterface
   * @param postMessageHandler Optionally, a handler to communicate with the content script.
   *   This is only needed in ServiceWorker. In web worker, we can use `postMessage` from
   *   DOM API directly.
   */
  constructor(
    engine: EngineInterface,
    postMessageHandler?: PostMessageHandler,
    initProgressCallback?: (report: InitProgressReport) => void
  ) {
    this.engine = engine;
    this.postMessageHandler = postMessageHandler;
    const defaultInitProgressCallback = (report: InitProgressReport) => {
      const msg: WorkerResponse = {
        kind: "initProgressCallback",
        uuid: "",
        content: report,
      };
      this.postMessageInternal(msg);
    };
    this.engine.setInitProgressCallback(
      initProgressCallback || defaultInitProgressCallback
    );
  }

  postMessageInternal(event: any) {
    // Use the Worker API postMessage by default
    this.postMessageHandler
      ? this.postMessageHandler.postMessage(event)
      : postMessage(event);
  }

  setPostMessageHandler(postMessageHandler: PostMessageHandler) {
    this.postMessageHandler = postMessageHandler;
  }

  async handleTask<T extends MessageContent>(
    uuid: string,
    task: () => Promise<T>
  ) {
    try {
      const res = await task();
      const msg: WorkerResponse = {
        kind: "return",
        uuid: uuid,
        content: res,
      };
      this.postMessageInternal(msg);
    } catch (err) {
      const errStr = (err as object).toString();
      const msg: WorkerResponse = {
        kind: "throw",
        uuid: uuid,
        content: errStr,
      };
      this.postMessageInternal(msg);
    }
  }

  onmessage(
    event: any,
    onComplete?: (value: any) => void,
    onError?: () => void
  ) {
    let msg: WorkerRequest;
    if (event instanceof MessageEvent) {
      msg = event.data as WorkerRequest;
    } else {
      msg = event as WorkerRequest;
    }
    switch (msg.kind) {
      case "reload": {
        this.handleTask(msg.uuid, async () => {
          const params = msg.content as ReloadParams;
          await this.engine.reload(
            params.modelId,
            params.chatOpts,
            params.appConfig
          );
          onComplete?.(null);
          return null;
        });
        return;
      }
      case "generate": {
        this.handleTask(msg.uuid, async () => {
          const params = msg.content as GenerateParams;
          const progressCallback = (step: number, currentMessage: string) => {
            const cbMessage: WorkerResponse = {
              kind: "generateProgressCallback",
              uuid: msg.uuid,
              content: {
                step: step,
                currentMessage: currentMessage,
              },
            };
            this.postMessageInternal(cbMessage);
          };
          const res = await this.engine.generate(
            params.input,
            progressCallback,
            params.streamInterval,
            params.genConfig
          );
          onComplete?.(res);
          return res;
        });
        return;
      }
      case "forwardTokensAndSample": {
        this.handleTask(msg.uuid, async () => {
          const params = msg.content as ForwardTokensAndSampleParams;
          const res = await this.engine.forwardTokensAndSample(
            params.inputIds,
            params.isPrefill
          );
          onComplete?.(res);
          return res;
        });
        return;
      }
      case "chatCompletionNonStreaming": {
        // Directly return the ChatCompletion response
        this.handleTask(msg.uuid, async () => {
          const params = msg.content as ChatCompletionNonStreamingParams;
          const res = await this.engine.chatCompletion(params.request);
          onComplete?.(res);
          return res;
        });
        return;
      }
      case "chatCompletionStreamInit": {
        // One-time set up that instantiates the chunk generator in worker
        this.handleTask(msg.uuid, async () => {
          const params = msg.content as ChatCompletionStreamInitParams;
          this.chatCompletionAsyncChunkGenerator =
            (await this.engine.chatCompletion(
              params.request
            )) as AsyncGenerator<ChatCompletionChunk, void, void>;
          onComplete?.(null);
          return null;
        });
        return;
      }
      case "chatCompletionStreamNextChunk": {
        // For any subsequent request, we return whatever `next()` yields
        this.handleTask(msg.uuid, async () => {
          if (this.chatCompletionAsyncChunkGenerator === undefined) {
            throw Error(
              "Chunk generator in worker should be instantiated by now."
            );
          }
          // Yield the next chunk
          const { value } = await this.chatCompletionAsyncChunkGenerator.next();
          onComplete?.(value);
          return value;
        });
        return;
      }
      case "runtimeStatsText": {
        this.handleTask(msg.uuid, async () => {
          const res = await this.engine.runtimeStatsText();
          onComplete?.(res);
          return res;
        });
        return;
      }
      case "interruptGenerate": {
        this.handleTask(msg.uuid, async () => {
          this.engine.interruptGenerate();
          onComplete?.(null);
          return null;
        });
        return;
      }
      case "unload": {
        this.handleTask(msg.uuid, async () => {
          await this.engine.unload();
          onComplete?.(null);
          return null;
        });
        return;
      }
      case "resetChat": {
        this.handleTask(msg.uuid, async () => {
          const params = msg.content as ResetChatParams;
          await this.engine.resetChat(params.keepStats);
          onComplete?.(null);
          return null;
        });
        return;
      }
      case "getMaxStorageBufferBindingSize": {
        this.handleTask(msg.uuid, async () => {
          const res = await this.engine.getMaxStorageBufferBindingSize();
          onComplete?.(res);
          return res;
        });
        return;
      }
      case "getGPUVendor": {
        this.handleTask(msg.uuid, async () => {
          const res = await this.engine.getGPUVendor();
          onComplete?.(res);
          return res;
        });
        return;
      }
      case "getMessage": {
        this.handleTask(msg.uuid, async () => {
          const res = await this.engine.getMessage();
          onComplete?.(res);
          return res;
        });
        return;
      }
      case "customRequest": {
        onComplete?.(null);
        return;
      }
      default: {
        if (msg.kind && msg.content) {
          onError?.();
          throw Error(
            "Unknown message kind, msg: [" + msg.kind + "] " + msg.content
          );
        } else {
          // Ignore irrelavent events
          onComplete?.(null);
        }
      }
    }
  }
}

export interface ChatWorker {
  onmessage: any;
  postMessage: (message: any) => void;
}

/**
 * Creates `WebWorkerEngine`, a client that holds the same interface as `Engine`.
 *
 * Equivalent to `new webllm.WebWorkerEngine(worker).reload(...)`.
 *
 * @param worker The worker that holds the actual Engine, intialized with `new Worker()`.
 * @param modelId The model to load, needs to either be in `webllm.prebuiltAppConfig`, or in
 * `engineConfig.appConfig`.
 * @param engineConfig Optionally configures the engine, see `webllm.EngineConfig` for more.
 * @returns An initialized `WebLLM.WebWorkerEngine` with `modelId` loaded.
 *
 * @note engineConfig.logitProcessorRegistry is ignored for `CreateWebWorkEngine()`.
 */
export async function CreateWebWorkerEngine(
  worker: any,
  modelId: string,
  engineConfig?: EngineConfig
): Promise<WebWorkerEngine> {
  const webWorkerEngine = new WebWorkerEngine(worker);
  webWorkerEngine.setInitProgressCallback(engineConfig?.initProgressCallback);
  await webWorkerEngine.reload(
    modelId,
    engineConfig?.chatOpts,
    engineConfig?.appConfig
  );
  return webWorkerEngine;
}

/**
 * A client of Engine that exposes the same interface
 *
 * @example
 *
 * const chat = new webllm.WebWorkerEngine(new Worker(
 *   new URL('./worker.ts', import.meta.url),
 *   {type: 'module'}
 * ));
 */
export class WebWorkerEngine implements EngineInterface {
  public worker: ChatWorker;
  public chat: API.Chat;

  private initProgressCallback?: InitProgressCallback;
  private generateCallbackRegistry = new Map<
    string,
    GenerateProgressCallback
  >();
  private pendingPromise = new Map<string, (msg: WorkerResponse) => void>();

  constructor(worker: ChatWorker) {
    this.worker = worker;
    worker.onmessage = (event: any) => {
      this.onmessage(event);
    };
    this.chat = new API.Chat(this);
  }

  setInitProgressCallback(initProgressCallback?: InitProgressCallback) {
    this.initProgressCallback = initProgressCallback;
  }

  getInitProgressCallback(): InitProgressCallback | undefined {
    return this.initProgressCallback;
  }

  protected getPromise<T extends MessageContent>(
    msg: WorkerRequest
  ): Promise<T> {
    const uuid = msg.uuid;
    const executor = (
      resolve: (arg: T) => void,
      reject: (arg: any) => void
    ) => {
      const cb = (msg: WorkerResponse) => {
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

  async reload(
    modelId: string,
    chatOpts?: ChatOptions,
    appConfig?: AppConfig
  ): Promise<void> {
    const msg: WorkerRequest = {
      kind: "reload",
      uuid: crypto.randomUUID(),
      content: {
        modelId: modelId,
        chatOpts: chatOpts,
        appConfig: appConfig,
      },
    };
    await this.getPromise<null>(msg);
  }

  async getMaxStorageBufferBindingSize(): Promise<number> {
    const msg: WorkerRequest = {
      kind: "getMaxStorageBufferBindingSize",
      uuid: crypto.randomUUID(),
      content: null,
    };
    return await this.getPromise<number>(msg);
  }

  async getGPUVendor(): Promise<string> {
    const msg: WorkerRequest = {
      kind: "getGPUVendor",
      uuid: crypto.randomUUID(),
      content: null,
    };
    return await this.getPromise<string>(msg);
  }

  async getMessage(): Promise<string> {
    const msg: WorkerRequest = {
      kind: "getMessage",
      uuid: crypto.randomUUID(),
      content: null,
    };
    return await this.getPromise<string>(msg);
  }

  async generate(
    input: string | ChatCompletionRequestNonStreaming,
    progressCallback?: GenerateProgressCallback,
    streamInterval?: number,
    genConfig?: GenerationConfig
  ): Promise<string> {
    const msg: WorkerRequest = {
      kind: "generate",
      uuid: crypto.randomUUID(),
      content: {
        input: input,
        streamInterval: streamInterval,
        genConfig: genConfig,
      },
    };
    if (progressCallback !== undefined) {
      this.generateCallbackRegistry.set(msg.uuid, progressCallback);
    }
    return await this.getPromise<string>(msg);
  }

  async runtimeStatsText(): Promise<string> {
    const msg: WorkerRequest = {
      kind: "runtimeStatsText",
      uuid: crypto.randomUUID(),
      content: null,
    };
    return await this.getPromise<string>(msg);
  }

  interruptGenerate(): void {
    const msg: WorkerRequest = {
      kind: "interruptGenerate",
      uuid: crypto.randomUUID(),
      content: null,
    };
    this.getPromise<null>(msg);
  }

  async unload(): Promise<void> {
    const msg: WorkerRequest = {
      kind: "unload",
      uuid: crypto.randomUUID(),
      content: null,
    };
    await this.getPromise<null>(msg);
  }

  async resetChat(keepStats = false): Promise<void> {
    const msg: WorkerRequest = {
      kind: "resetChat",
      uuid: crypto.randomUUID(),
      content: {
        keepStats: keepStats,
      },
    };
    await this.getPromise<null>(msg);
  }

  async forwardTokensAndSample(
    inputIds: Array<number>,
    isPrefill: boolean
  ): Promise<number> {
    const msg: WorkerRequest = {
      kind: "forwardTokensAndSample",
      uuid: crypto.randomUUID(),
      content: {
        inputIds: inputIds,
        isPrefill: isPrefill,
      },
    };
    return await this.getPromise<number>(msg);
  }

  /**
   * Every time the generator is called, we post a message to the worker asking it to
   * decode one step, and we expect to receive a message of `ChatCompletionChunk` from
   * the worker which we yield. The last message is `void`, meaning the generator has nothing
   * to yield anymore.
   */
  async *chatCompletionAsyncChunkGenerator(): AsyncGenerator<
    ChatCompletionChunk,
    void,
    void
  > {
    // Every time it gets called, sends message to worker, asking for the next chunk
    while (true) {
      const msg: WorkerRequest = {
        kind: "chatCompletionStreamNextChunk",
        uuid: crypto.randomUUID(),
        content: null,
      };
      const ret = await this.getPromise<ChatCompletionChunk>(msg);
      // If the worker's generator reached the end, it would return a `void`
      if (typeof ret !== "object") {
        break;
      }
      yield ret;
    }
  }

  async chatCompletion(
    request: ChatCompletionRequestNonStreaming
  ): Promise<ChatCompletion>;
  async chatCompletion(
    request: ChatCompletionRequestStreaming
  ): Promise<AsyncIterable<ChatCompletionChunk>>;
  async chatCompletion(
    request: ChatCompletionRequestBase
  ): Promise<AsyncIterable<ChatCompletionChunk> | ChatCompletion>;
  async chatCompletion(
    request: ChatCompletionRequest
  ): Promise<AsyncIterable<ChatCompletionChunk> | ChatCompletion> {
    if (request.stream) {
      // First let worker instantiate a generator
      const msg: WorkerRequest = {
        kind: "chatCompletionStreamInit",
        uuid: crypto.randomUUID(),
        content: {
          request: request,
        },
      };
      await this.getPromise<null>(msg);

      // Then return an async chunk generator that resides on the client side
      return this.chatCompletionAsyncChunkGenerator();
    }

    // Non streaming case is more straightforward
    const msg: WorkerRequest = {
      kind: "chatCompletionNonStreaming",
      uuid: crypto.randomUUID(),
      content: {
        request: request,
      },
    };
    return await this.getPromise<ChatCompletion>(msg);
  }

  onmessage(event: any) {
    let msg: WorkerResponse;
    if (event instanceof MessageEvent) {
      msg = event.data as WorkerResponse;
    } else {
      msg = event as WorkerResponse;
    }
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
        let unknownMsg = msg as any;
        throw Error(
          "Unknown message kind, msg=[" + unknownMsg.kind + "] " + unknownMsg.content
        );
      }
    }
  }
}
