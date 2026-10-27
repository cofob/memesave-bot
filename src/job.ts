import { Container, type StopParams } from "@cloudflare/containers";
import type { Env } from "./env";

const EXIT_RESTART = 75; // container/main.go exits with it on SIGTERM
const MAX_RESTARTS = 3;

/**
 * One-shot job container: runs one job and exits. `sleepAfter` is the hard timeout. A platform rollout
 * stops the container with SIGTERM: then the job starts again from the beginning on the new image.
 */
export abstract class JobContainer extends Container<Env> {
  sleepAfter = "4h";
  enableInternet = true;
  /** Storage key of the job id. */
  protected abstract key: string;
  protected abstract fail: (id: string, error: string) => Promise<void>;

  async run(id: string, envVars: Record<string, string>) {
    await this.ctx.storage.put({ [this.key]: id, envVars, restarts: 0 });
    await this.start({ envVars, enableInternet: true });
  }

  override async onActivityExpired() {
    await this.ctx.storage.put("timedOut", true);
    await super.onActivityExpired();
  }

  override async onStop({ exitCode }: StopParams) {
    await this.restartOrFail(exitCode === EXIT_RESTART, `container stopped, exit code ${exitCode}`);
  }

  /** The library calls only this, not onStop, when the container is lost without an exit code (for example in a rollout). */
  override async onError(error: unknown) {
    console.error("Container error:", error);
    await this.restartOrFail(true, `container error: ${error}`);
  }

  private async restartOrFail(restart: boolean, error: string) {
    const s = await this.ctx.storage.get<any>([this.key, "restarts", "timedOut"]);
    const id: string | undefined = s.get(this.key);
    const restarts: number = s.get("restarts") ?? MAX_RESTARTS;
    if (!id) return;
    if (restart && !s.get("timedOut") && restarts < MAX_RESTARTS) {
      await this.ctx.storage.put("restarts", restarts + 1);
      await this.schedule(1, "restart");
      return;
    }
    // No-op when the container already reported done or fail.
    await this.fail(id, error);
    await this.ctx.storage.put("finished", true);
  }

  /** The library writes its state after onStop, so the finished job's storage is deleted only after its alarm. */
  override async alarm(props?: AlarmInvocationInfo) {
    await super.alarm(props);
    if (!this.ctx.container?.running && (await this.ctx.storage.get("finished"))) await this.ctx.storage.deleteAll();
  }

  /** Deletes the storage of a job that finished before the cleanup in alarm; returns the number of deleted keys. */
  async purge() {
    if (this.ctx.container?.running) return -1;
    const n = (await this.ctx.storage.list()).size;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return n;
  }

  async restart() {
    const envVars = await this.ctx.storage.get<Record<string, string>>("envVars");
    await this.start({ envVars, enableInternet: true }).catch((e) => this.restartOrFail(true, `restart: ${e}`));
  }
}
