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
    const s = await this.ctx.storage.get<any>([this.key, "restarts", "timedOut"]);
    const id: string | undefined = s.get(this.key);
    const restarts: number = s.get("restarts") ?? MAX_RESTARTS;
    if (!id) return;
    if (exitCode === EXIT_RESTART && !s.get("timedOut") && restarts < MAX_RESTARTS) {
      await this.ctx.storage.put("restarts", restarts + 1);
      await this.schedule(1, "restart");
      return;
    }
    // No-op when the container already reported done or fail.
    await this.fail(id, `container stopped, exit code ${exitCode}`);
  }

  async restart() {
    const s = await this.ctx.storage.get<any>([this.key, "envVars"]);
    await this.start({ envVars: s.get("envVars"), enableInternet: true }).catch((e) => this.fail(s.get(this.key), `restart: ${e}`));
  }
}
