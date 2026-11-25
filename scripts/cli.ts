import 'dotenv/config';
import { createEtlContext, type EtlContext } from '@/etl/factory';

/**
 * Run a CLI command with a wired ETL context. Prints config errors plainly,
 * always disconnects, and exits with the code the command returns.
 */
export async function runCli(command: (ctx: EtlContext) => Promise<number>): Promise<void> {
    let ctx: EtlContext;
    try {
        ctx = createEtlContext();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exit(78); // EX_CONFIG
    }
    let code = 1;
    try {
        code = await command(ctx);
    } catch (error) {
        ctx.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'Command failed');
    } finally {
        await ctx.close();
    }
    process.exit(code);
}
