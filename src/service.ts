import { INestApplicationContext, Injectable } from '@nestjs/common';
import { Command, CommanderError } from 'commander';
import { EventEmitter } from 'events';

import { IConsoleOptions, ICreateCommandOptions, InjectCli } from './decorators';
import { formatResponse } from './helpers';

/**
 * The Command action handler type
 * Note: The last argument is always the command
 */
export type CommandActionHandler = (...args: any[]) => any | Promise<any>;

/**
 * The response of the
 */
export interface ICommandActionResponse {
    data: any;
    command: Command;
}

@Injectable()
export class ConsoleService {
    /**
     * An optional instance of the application.
     * Required to scan the application
     */
    protected container?: INestApplicationContext;

    /**
     * A Map holding group commands by name
     */
    protected commands: Map<string, Command> = new Map();

    /**
     * The root cli
     */
    protected cli: Command;

    constructor(@InjectCli() cli: Command) {
        this.cli = cli;
    }

    /**
     * Create an instance of root cli
     */
    static create() {
        const cli = new Command();
        // listen for root not found
        cli.on('command:*', (args: string[], unknown: string[]) => {
            throw new Error(`"${args[0]}" command not found`);
        });
        return cli;
    }

    /**
     * Reset the cli stack (for testing purpose only)
     */
    resetCli() {
        this.cli = ConsoleService.create();
    }

    /**
     * Log an error
     * @param command The command related to the error
     * @param error The error to format
     */
    logError(error: Error) {
        // tslint:disable-next-line:no-console
        return console.error(formatResponse(error));
    }

    /**
     * Get a cli
     * @param name Get a cli by name, if not set, the root cli is used
     */
    getCli(name?: string) {
        return name ? this.commands.get(name) : this.cli;
    }

    /**
     * Set the container
     */
    setContainer(container: INestApplicationContext): ConsoleService {
        this.container = container;
        return this;
    }

    /**
     * Get the container
     */
    getContainer(): INestApplicationContext {
        return this.container;
    }

    /**
     * Wrap an action handler to work with promise.
     */
    createHandler(
        action: CommandActionHandler
    ): (...args: any[]) => Promise<ICommandActionResponse> {
        return async (...args: any[]) => {
            const command = args[args.length - 1];

            let data = action(...args);
            if (data instanceof Promise) {
                data = await data;
            }

            return { data, command };
        };
    }

    /**
     * Execute the cli
     */
    async init(argv: string[]): Promise<ICommandActionResponse | undefined> {
        const cli = this.getCli();
        try {
            // if nothing was provided, display an error
            if (cli.commands.length === 0) {
                throw new CommanderError(
                    1,
                    'empty',
                    `The cli does not contain sub command`
                );
            }
            cli.exitOverride(e => {
                throw e;
            });

            const results: [ICommandActionResponse] = await cli.parseAsync(
                argv
            );

            if (!results.length) {
                let command: Command = cli.commands.find((c: Command) => {
                    const commandName = argv[argv.length - 1];
                    return c._name === commandName || c._alias === commandName;
                });
                if (!command) {
                    cli.help();
                } else {
                    command.help();
                }
            }
            return results[0];
        } catch (e) {
            if (e instanceof CommanderError) {
                // if commander throws a CommanderError async event or help has been executed
                // ignore response and error for help display
                if (/(helpDisplayed|commander\.help)/.test(e.code)) {
                    return;
                }
                if (/missingArgument/.test(e.code)) {
                    throw e;
                }
                // display others errors
            }
            this.logError(e);
            // always throw for promise
            throw e;
        }
    }

    /**
     * Create a Command
     *
     * @param options The options to create the commands
     * @param handler The handler of the command
     * @param parent The command to use as a parent
     */
    createCommand(
        options: ICreateCommandOptions,
        handler: (...args: any[]) => any | Promise<any>,
        parent: Command
    ) {
        const command = parent
            .command(options.command)
            .exitOverride((...args) => parent._exitCallback(...args));

        if (options.description) {
            command.description(options.description);
        }
        if (options.alias) {
            command.alias(options.alias);
        }
        if (Symbol.iterator in Object(options.options)) {
            for (const opt of options.options) {
                command.option(
                    opt.flags,
                    opt.description,
                    opt.fn,
                    opt.defaultValue
                );
            }
        }
        return command.action(this.createHandler(handler));
    }

    /**
     * Create a group of command.
     * @param options The options to create the grouped command
     * @param parent The command to use as a parent
     * @throws an error if the parent command contains explicit arguments, only simple commands are allowed (no spaces)
     */
    createGroupCommand(options: IConsoleOptions, parent: Command): Command {
        if (parent._args.length > 0) {
            throw new Error(
                'Sub commands cannot be applied to command with explicit args'
            );
        }
        const command = parent
            .command(options.name)
            .exitOverride((...args) => parent._exitCallback(...args));
        if (options.description) {
            command.description(options.description);
        }
        if (options.alias) {
            command.alias(options.alias);
        }

        const name = command.name();

        // register all named events now this will prevent commander to call the event command:*
        function _onSubCommand(args: string[], unknown: string[]) {
            // Trigger any releated sub command events passing the unknown args from parent
            // args are the unknown args
            const commandArgs = command.parseOptions(args.concat(unknown));
            command.parseArgs(commandArgs.args, commandArgs.unknown);
        }
        parent.on('command:' + name, _onSubCommand);
        if (options.alias) {
            parent.on('command:' + options.alias, _onSubCommand);
        }

        // listen for not found on child
        command.on('command:*', (args: string[]) => {
            throw new Error(`"${args[0]}" command not found`);
        });

        // add the command to the command Map. this will help us to manipulate parent commands
        this.commands.set(name, command);

        return command;
    }
}
