// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { Kernel } from '@jupyterlab/services';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import * as uuid from 'uuid/v4';
import { CancellationToken } from 'vscode-jsonrpc';

import { ILiveShareApi, IWorkspaceService } from '../../common/application/types';
import { Cancellation, CancellationError } from '../../common/cancellation';
import { IFileSystem, TemporaryDirectory } from '../../common/platform/types';
import { IProcessService, IProcessServiceFactory, IPythonExecutionFactory, SpawnOptions } from '../../common/process/types';
import { IAsyncDisposableRegistry, IConfigurationService, IDisposableRegistry, ILogger } from '../../common/types';
import * as localize from '../../common/utils/localize';
import { noop } from '../../common/utils/misc';
import { EXTENSION_ROOT_DIR } from '../../constants';
import { IInterpreterService, IKnownSearchPathsForInterpreters, PythonInterpreter } from '../../interpreter/contracts';
import { IServiceContainer } from '../../ioc/types';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { JupyterCommands, RegExpValues, Telemetry } from '../constants';
import {
    IConnection,
    IJupyterCommand,
    IJupyterCommandFactory,
    IJupyterExecution,
    IJupyterKernelSpec,
    IJupyterSessionManager,
    INotebookServer
} from '../types';
import { JupyterConnection, JupyterServerInfo } from './jupyterConnection';
import { JupyterKernelSpec } from './jupyterKernelSpec';

export class JupyterExecutionBase implements IJupyterExecution {

    private processServicePromise: Promise<IProcessService>;
    private commands: Record<string, IJupyterCommand> = {};
    private jupyterPath: string | undefined;
    private usablePythonInterpreter: PythonInterpreter | undefined;

    constructor(liveShare: ILiveShareApi,
                private executionFactory: IPythonExecutionFactory,
                private interpreterService: IInterpreterService,
                private processServiceFactory: IProcessServiceFactory,
                private knownSearchPaths: IKnownSearchPathsForInterpreters,
                private logger: ILogger,
                private disposableRegistry: IDisposableRegistry,
                private asyncRegistry: IAsyncDisposableRegistry,
                private fileSystem: IFileSystem,
                private sessionManager: IJupyterSessionManager,
                workspace: IWorkspaceService,
                private configuration: IConfigurationService,
                private commandFactory : IJupyterCommandFactory,
                private serviceContainer: IServiceContainer) {
        this.processServicePromise = this.processServiceFactory.create();
        this.disposableRegistry.push(this.interpreterService.onDidChangeInterpreter(() => this.onSettingsChanged()));
        this.disposableRegistry.push(this);

        if (workspace) {
            const disposable = workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('python.dataScience', undefined)) {
                    // When config changes happen, recreate our commands.
                    this.onSettingsChanged();
                }
            });
            this.disposableRegistry.push(disposable);
        }
    }

    public dispose() : Promise<void> {
        // Clear our usableJupyterInterpreter
        this.onSettingsChanged();
        return Promise.resolve();
    }

    public isNotebookSupported(cancelToken?: CancellationToken): Promise<boolean> {
        // See if we can find the command notebook
        return Cancellation.race(() => this.isCommandSupported(JupyterCommands.NotebookCommand, cancelToken), cancelToken);
    }

    public async getUsableJupyterPython(cancelToken?: CancellationToken): Promise<PythonInterpreter | undefined> {
        // Only try to compute this once.
        if (!this.usablePythonInterpreter) {
            this.usablePythonInterpreter = await Cancellation.race(() => this.getUsableJupyterPythonImpl(cancelToken), cancelToken);
        }
        return this.usablePythonInterpreter;
    }

    public isImportSupported(cancelToken?: CancellationToken): Promise<boolean> {
        // See if we can find the command nbconvert
        return Cancellation.race(() => this.isCommandSupported(JupyterCommands.ConvertCommand), cancelToken);
    }

    public isKernelCreateSupported(cancelToken?: CancellationToken): Promise<boolean> {
        // See if we can find the command ipykernel
        return Cancellation.race(() => this.isCommandSupported(JupyterCommands.KernelCreateCommand), cancelToken);
    }

    public isKernelSpecSupported(cancelToken?: CancellationToken): Promise<boolean> {
        // See if we can find the command kernelspec
        return Cancellation.race(() => this.isCommandSupported(JupyterCommands.KernelSpecCommand), cancelToken);
    }

    public connectToNotebookServer(uri: string | undefined, usingDarkTheme: boolean, useDefaultConfig: boolean, cancelToken?: CancellationToken, workingDir?: string): Promise<INotebookServer | undefined> {
        // Return nothing if we cancel
        return Cancellation.race(async () => {
            let connection: IConnection;
            let kernelSpec: IJupyterKernelSpec | undefined;

            // If our uri is undefined or if it's set to local launch we need to launch a server locally
            if (!uri) {
                const launchResults = await this.startNotebookServer(useDefaultConfig, cancelToken);
                if (launchResults) {
                    connection = launchResults.connection;
                    kernelSpec = launchResults.kernelSpec;
                } else {
                    // Throw a cancellation error if we were canceled.
                    Cancellation.throwIfCanceled(cancelToken);

                    // Otherwise we can't connect
                    throw new Error(localize.DataScience.jupyterNotebookFailure().format(''));
                }
            } else {
                // If we have a URI spec up a connection info for it
                connection = this.createRemoteConnectionInfo(uri);
                kernelSpec = undefined;
            }

            try {
                // If we don't have a kernel spec yet, check using our current connection
                if (!kernelSpec) {
                    kernelSpec = await this.getMatchingKernelSpec(connection, cancelToken);
                }

                // If still not found, log an error (this seems possible for some people, so use the default)
                if (!kernelSpec) {
                    this.logger.logError(localize.DataScience.jupyterKernelSpecNotFound());
                }

                // Try to connect to our jupyter process
                const result = this.serviceContainer.get<INotebookServer>(INotebookServer);
                await result.connect(connection, kernelSpec, usingDarkTheme, cancelToken, workingDir);
                sendTelemetryEvent(uri ? Telemetry.ConnectRemoteJupyter : Telemetry.ConnectLocalJupyter);
                return result;
            } catch (err) {
                // Something else went wrong
                sendTelemetryEvent(Telemetry.ConnectFailedJupyter);
                throw new Error(localize.DataScience.jupyterNotebookConnectFailed().format(connection.baseUrl, err));
            }
        }, cancelToken);
    }

    public async spawnNotebook(file: string): Promise<void> {
        // First we find a way to start a notebook server
        const notebookCommand = await this.findBestCommand('notebook');
        if (!notebookCommand) {
            throw new Error(localize.DataScience.jupyterNotSupported());
        }

        const args: string[] = [`--NotebookApp.file_to_run=${file}`];

        // Don't wait for the exec to finish and don't dispose. It's up to the user to kill the process
        notebookCommand.exec(args, { throwOnStdErr: false, encoding: 'utf8' }).ignoreErrors();
    }

    public async importNotebook(file: string, template: string): Promise<string> {
        // First we find a way to start a nbconvert
        const convert = await this.findBestCommand(JupyterCommands.ConvertCommand);
        if (!convert) {
            throw new Error(localize.DataScience.jupyterNbConvertNotSupported());
        }

        // Wait for the nbconvert to finish
        const result = await convert.exec([file, '--to', 'python', '--stdout', '--template', template], { throwOnStdErr: false, encoding: 'utf8' });
        if (result.stderr) {
            // Stderr on nbconvert doesn't indicate failure. Just log the result
            this.logger.logInformation(result.stderr);
        }
        return result.stdout;
    }

    protected async getMatchingKernelSpec(connection?: IConnection, cancelToken?: CancellationToken): Promise<IJupyterKernelSpec | undefined> {
        // If not using an active connection, check on disk
        if (!connection) {
            // Get our best interpreter. We want its python path
            const bestInterpreter = await this.getUsableJupyterPython(cancelToken);

            // Enumerate our kernel specs that jupyter will know about and see if
            // one of them already matches based on path
            if (bestInterpreter && !await this.hasSpecPathMatch(bestInterpreter, cancelToken)) {

                // Nobody matches on path, so generate a new kernel spec
                if (await this.isKernelCreateSupported(cancelToken)) {
                    await this.addMatchingSpec(bestInterpreter, cancelToken);
                }
            }
        }

        // Now enumerate them again
        const enumerator = connection ? () => this.sessionManager.getActiveKernelSpecs(connection) : () => this.enumerateSpecs(cancelToken);

        // Then find our match
        return this.findSpecMatch(enumerator);
    }

    private createRemoteConnectionInfo = (uri: string): IConnection => {
        let url: URL;
        try {
            url = new URL(uri);
        } catch (err) {
            // This should already have been parsed when set, so just throw if it's not right here
            throw err;
        }

        return {
            baseUrl: `${url.protocol}//${url.host}${url.pathname}`,
            token: `${url.searchParams.get('token')}`,
            localLaunch: false,
            dispose: noop
        };
    }

    @captureTelemetry(Telemetry.StartJupyter)
    private async startNotebookServer(useDefaultConfig: boolean, cancelToken?: CancellationToken): Promise<{ connection: IConnection; kernelSpec: IJupyterKernelSpec | undefined }> {
        // First we find a way to start a notebook server
        const notebookCommand = await this.findBestCommand(JupyterCommands.NotebookCommand, cancelToken);
        if (!notebookCommand) {
            throw new Error(localize.DataScience.jupyterNotSupported());
        }

        // Now actually launch it
        try {
            // Generate a temp dir with a unique GUID, both to match up our started server and to easily clean up after
            const tempDir = await this.generateTempDir();
            this.disposableRegistry.push(tempDir);

            // In the temp dir, create an empty config python file. This is the same
            // as starting jupyter with all of the defaults.
            const configFile = useDefaultConfig ? path.join(tempDir.path, 'jupyter_notebook_config.py') : undefined;
            if (configFile) {
                await this.fileSystem.writeFile(configFile, '');
                this.logger.logInformation(`Generating custom default config at ${configFile}`);
            }

            // Create extra args based on if we have a config or not
            const extraArgs: string[] = [];
            if (useDefaultConfig) {
                extraArgs.push(`--config=${configFile}`);
            }
            // Check for the debug environment variable being set. Setting this
            // causes Jupyter to output a lot more information about what it's doing
            // under the covers and can be used to investigate problems with Jupyter.
            if (process.env && process.env.VSCODE_PYTHON_DEBUG_JUPYTER) {
                extraArgs.push('--debug');
            }

            // Use this temp file and config file to generate a list of args for our command
            const args: string[] = [...['--no-browser', `--notebook-dir=${tempDir.path}`], ...extraArgs];

            // Before starting the notebook process, make sure we generate a kernel spec
            const kernelSpec = await this.getMatchingKernelSpec(undefined, cancelToken);

            // Then use this to launch our notebook process.
            const launchResult = await notebookCommand.execObservable(args, { throwOnStdErr: false, encoding: 'utf8', token: cancelToken });

            // Make sure this process gets cleaned up. We might be canceled before the connection finishes.
            if (launchResult && cancelToken) {
                cancelToken.onCancellationRequested(() => {
                    launchResult.dispose();
                });
            }

            // Wait for the connection information on this result
            const connection = await JupyterConnection.waitForConnection(
                tempDir.path, this.getJupyterServerInfo, launchResult, this.serviceContainer, cancelToken);

            return {
                connection: connection,
                kernelSpec: kernelSpec
            };
        } catch (err) {
            if (err instanceof CancellationError) {
                throw err;
            }

            // Something else went wrong
            throw new Error(localize.DataScience.jupyterNotebookFailure().format(err));
        }
    }

    private getUsableJupyterPythonImpl = async (cancelToken?: CancellationToken): Promise<PythonInterpreter | undefined> => {
        // This should be the best interpreter for notebooks
        const found = await this.findBestCommand(JupyterCommands.NotebookCommand, cancelToken);
        if (found) {
            return found.interpreter();
        }

        return undefined;
    }

    private getJupyterServerInfo = async (cancelToken?: CancellationToken): Promise<JupyterServerInfo[] | undefined> => {
        // We have a small python file here that we will execute to get the server info from all running Jupyter instances
        const bestInterpreter = await this.getUsableJupyterPython(cancelToken);
        if (bestInterpreter) {
            const newOptions: SpawnOptions = { mergeStdOutErr: true, token: cancelToken };
            const launcher = await this.executionFactory.createActivatedEnvironment({ resource: undefined, interpreter: bestInterpreter });
            const file = path.join(EXTENSION_ROOT_DIR, 'pythonFiles', 'datascience', 'getServerInfo.py');
            const serverInfoString = await launcher.exec([file], newOptions);

            let serverInfos: JupyterServerInfo[];
            try {
                // Parse out our results, return undefined if we can't suss it out
                serverInfos = JSON.parse(serverInfoString.stdout.trim()) as JupyterServerInfo[];
            } catch (err) {
                return undefined;
            }
            return serverInfos;
        }

        return undefined;
    }

    private onSettingsChanged() {
        // Clear our usableJupyterInterpreter so that we recompute our values
        this.usablePythonInterpreter = undefined;
        this.commands = {};
    }

    private async addMatchingSpec(bestInterpreter: PythonInterpreter, cancelToken?: CancellationToken): Promise<void> {
        const displayName = localize.DataScience.historyTitle();
        const ipykernelCommand = await this.findBestCommand(JupyterCommands.KernelCreateCommand, cancelToken);

        // If this fails, then we just skip this spec
        try {
            // Run the ipykernel install command. This will generate a new kernel spec. However
            // it will be pointing to the python that ran it. We'll fix that up afterwards
            const name = uuid();
            if (ipykernelCommand) {
                const result = await ipykernelCommand.exec(['install', '--user', '--name', name, '--display-name', `'${displayName}'`], { throwOnStdErr: true, encoding: 'utf8', token: cancelToken });

                // Result should have our file name.
                const match = RegExpValues.PyKernelOutputRegEx.exec(result.stdout);
                const diskPath = match && match !== null && match.length > 1 ? path.join(match[1], 'kernel.json') : await this.findSpecPath(name);

                // Make sure we delete this file at some point. When we close VS code is probably good. It will also be destroy when
                // the kernel spec goes away
                this.asyncRegistry.push({
                    dispose: async () => {
                        if (!diskPath) {
                            return;
                        }
                        try {
                            await fs.remove(path.dirname(diskPath));
                        } catch {
                            noop();
                        }
                    }
                });

                // If that works, rewrite our active interpreter into the argv
                if (diskPath && bestInterpreter) {
                    if (await fs.pathExists(diskPath)) {
                        const specModel: Kernel.ISpecModel = await fs.readJSON(diskPath);
                        specModel.argv[0] = bestInterpreter.path;
                        await fs.writeJSON(diskPath, specModel, { flag: 'w', encoding: 'utf8' });
                    }
                }
            }
        } catch (err) {
            this.logger.logError(err);
        }
    }

    private findSpecPath = async (specName: string, cancelToken?: CancellationToken): Promise<string | undefined> => {
        // Enumerate all specs and get path for the match
        const specs = await this.enumerateSpecs(cancelToken);
        const match = specs!
            .filter(s => s !== undefined)
            .find(s => {
            const js = s as JupyterKernelSpec;
            return js && js.name === specName;
        }) as JupyterKernelSpec;
        return match ? match.specFile : undefined;
    }

    private async generateTempDir(): Promise<TemporaryDirectory> {
        const resultDir = path.join(os.tmpdir(), uuid());
        await this.fileSystem.createDirectory(resultDir);

        return {
            path: resultDir,
            dispose: async () => {
                // Try ten times. Process may still be up and running.
                // We don't want to do async as async dispose means it may never finish and then we don't
                // delete
                let count = 0;
                while (count < 10) {
                    try {
                        await fs.remove(resultDir);
                        count = 10;
                    } catch {
                        count += 1;
                    }
                }
            }
        };
    }

    private isCommandSupported = async (command: string, cancelToken?: CancellationToken): Promise<boolean> => {
        // See if we can find the command
        try {
            const result = await this.findBestCommand(command, cancelToken);
            return result !== undefined;
        } catch (err) {
            this.logger.logWarning(err);
            return false;
        }
    }

    private hasSpecPathMatch = async (info: PythonInterpreter | undefined, cancelToken?: CancellationToken): Promise<boolean> => {
        if (info) {
            // Enumerate our specs
            const specs = await this.enumerateSpecs(cancelToken);

            // See if any of their paths match
            return specs.findIndex(s => {
                if (info && s && s.path) {
                    return this.fileSystem.arePathsSame(s.path, info.path);
                }
                return false;
            }) >= 0;
        }

        // If no active interpreter, just act like everything is okay as we can't find a new spec anyway
        return true;
    }

    //tslint:disable-next-line:cyclomatic-complexity
    private findSpecMatch = async (enumerator: () => Promise<(IJupyterKernelSpec | undefined)[]>): Promise<IJupyterKernelSpec | undefined> => {
        // Extract our current python information that the user has picked.
        // We'll match against this.
        const info = await this.interpreterService.getActiveInterpreter();
        let bestScore = 0;
        let bestSpec: IJupyterKernelSpec | undefined;

        // Then enumerate our specs
        const specs = await enumerator();

        // For each get its details as we will likely need them
        const specDetails = await Promise.all(specs.map(async s => {
            if (s && s.path && s.path.length > 0 && await fs.pathExists(s.path)) {
                return this.interpreterService.getInterpreterDetails(s.path);
            }
        }));

        for (let i = 0; specs && i < specs.length; i += 1) {
            const spec = specs[i];
            let score = 0;

            if (spec && spec.path && spec.path.length > 0 && info && spec.path === info.path) {
                // Path match
                score += 10;
            }
            if (spec && spec.language && spec.language.toLocaleLowerCase() === 'python') {
                // Language match
                score += 1;

                // See if the version is the same
                if (info && info.version && specDetails[i]) {
                    const details = specDetails[i];
                    if (details && details.version) {
                        if (details.version.major === info.version.major) {
                            // Major version match
                            score += 4;

                            if (details.version.minor === info.version.minor) {
                                // Minor version match
                                score += 2;

                                if (details.version.patch === info.version.patch) {
                                    // Minor version match
                                    score += 1;
                                }
                            }
                        }
                    }
                } else if (info && info.version && spec && spec.path && spec.path.toLocaleLowerCase() === 'python' && spec.name) {
                    // This should be our current python.

                    // Search for a digit on the end of the name. It should match our major version
                    const match = /\D+(\d+)/.exec(spec.name);
                    if (match && match !== null && match.length > 0) {
                        // See if the version number matches
                        const nameVersion = parseInt(match[0], 10);
                        if (nameVersion && nameVersion === info.version.major) {
                            score += 4;
                        }
                    }
                }
            }

            // Update high score
            if (score > bestScore) {
                bestScore = score;
                bestSpec = spec;
            }
        }

        // If still not set, at least pick the first one
        if (!bestSpec && specs && specs.length > 0) {
            bestSpec = specs[0];
        }

        return bestSpec;
    }

    private async readSpec(kernelSpecOutputLine: string) : Promise<JupyterKernelSpec | undefined> {
        const match = RegExpValues.KernelSpecOutputRegEx.exec(kernelSpecOutputLine);
        if (match && match !== null && match.length > 2) {
            // Second match should be our path to the kernel spec
            const file = path.join(match[2], 'kernel.json');
            if (await fs.pathExists(file)) {
                // Turn this into a IJupyterKernelSpec
                const model = await fs.readJSON(file, { encoding: 'utf8' });
                model.name = match[1];
                return new JupyterKernelSpec(model, file);
            }
        }

        return undefined;
    }

    private enumerateSpecs = async (cancelToken?: CancellationToken): Promise<(JupyterKernelSpec | undefined)[]> => {
        if (await this.isKernelSpecSupported()) {
            const kernelSpecCommand = await this.findBestCommand(JupyterCommands.KernelSpecCommand);

            if (kernelSpecCommand) {
                try {
                    // Ask for our current list.
                    const list = await kernelSpecCommand.exec(['list'], { throwOnStdErr: true, encoding: 'utf8' });

                    // This should give us back a key value pair we can parse
                    const lines = list.stdout.splitLines({ trim: false, removeEmptyEntries: true });

                    // Generate all of the promises at once
                    const promises = lines.map(l => this.readSpec(l));

                    // Then let them run concurrently (they are file io)
                    const specs = await Promise.all(promises);
                    return specs!.filter(s => s);
                } catch {
                    // This is failing for some folks. In that case return nothing
                    return [];
                }
            }
        }

        return [];
    }

    private findInterpreterCommand = async (command: string, interpreter: PythonInterpreter, cancelToken?: CancellationToken): Promise<IJupyterCommand | undefined> => {
        // If the module is found on this interpreter, then we found it.
        if (interpreter && await this.doesModuleExist(command, interpreter, cancelToken) && !Cancellation.isCanceled(cancelToken)) {

            // Our command args are different based on the command. ipykernel is not a jupyter command
            const args = command === JupyterCommands.KernelCreateCommand ? ['-m', command] : ['-m', 'jupyter', command];
            return this.commandFactory.createInterpreterCommand(args, interpreter);
        }

        return undefined;
    }

    private lookForJupyterInDirectory = async (pathToCheck: string): Promise<string[]> => {
        try {
            const files = await this.fileSystem.getFiles(pathToCheck);
            return files ? files.filter(s => RegExpValues.CheckJupyterRegEx.test(path.basename(s))) : [];
        } catch (err) {
            this.logger.logWarning('Python Extension (fileSystem.getFiles):', err);
        }
        return [] as string[];
    }

    private searchPathsForJupyter = async (): Promise<string | undefined> => {
        if (!this.jupyterPath) {
            const paths = this.knownSearchPaths.getSearchPaths();
            for (let i = 0; i < paths.length && !this.jupyterPath; i += 1) {
                const found = await this.lookForJupyterInDirectory(paths[i]);
                if (found.length > 0) {
                    this.jupyterPath = found[0];
                }
            }
        }
        return this.jupyterPath;
    }

    private findPathCommand = async (command: string, cancelToken?: CancellationToken): Promise<IJupyterCommand | undefined> => {
        if (await this.doesJupyterCommandExist(command, cancelToken) && !Cancellation.isCanceled(cancelToken)) {
            // Search the known paths for jupyter
            const jupyterPath = await this.searchPathsForJupyter();
            if (jupyterPath) {
                return this.commandFactory.createProcessCommand(jupyterPath, [command]);
            }
        }
        return undefined;
    }

    private supportsSearchingForCommands() : boolean {
        if (this.configuration) {
            const settings = this.configuration.getSettings();
            if (settings) {
                return settings.datascience.searchForJupyter;
            }
        }
        return true;
    }

    // For jupyter,
    // - Look in current interpreter, if found create something that has path and args
    // - Look in other interpreters, if found create something that has path and args
    // - Look on path, if found create something that has path and args
    // For general case
    // - Look for module in current interpreter, if found create something with python path and -m module
    // - Look in other interpreters, if found create something with python path and -m module
    // - Look on path for jupyter, if found create something with jupyter path and args
    private findBestCommand = async (command: string, cancelToken?: CancellationToken): Promise<IJupyterCommand | undefined> => {
        // See if we already have this command in list
        if (!this.commands.hasOwnProperty(command)) {
            // Not found, try to find it.

            // First we look in the current interpreter
            const current = await this.interpreterService.getActiveInterpreter();
            let found = current ? await this.findInterpreterCommand(command, current, cancelToken) : undefined;
            if (!found && this.supportsSearchingForCommands()) {
                // Look through all of our interpreters (minus the active one at the same time)
                const all = await this.interpreterService.getInterpreters();
                const promises = all.filter(i => i !== current).map(i => this.findInterpreterCommand(command, i, cancelToken));
                const foundList = await Promise.all(promises);

                // Then go through all of the found ones and pick the closest python match
                if (current && current.version) {
                    let bestScore = -1;
                    for (let i = 0; i < foundList.length; i += 1) {
                        let currentScore = 0;
                        const entry = foundList[i];
                        if (entry) {
                            const interpreter = await entry.interpreter();
                            const version = interpreter ? interpreter.version : undefined;
                            if (version) {
                                if (version.major === current.version.major) {
                                    currentScore += 4;
                                    if (version.minor === current.version.minor) {
                                        currentScore += 2;
                                        if (version.patch === current.version.patch) {
                                            currentScore += 1;
                                        }
                                    }
                                }
                            }
                            if (currentScore > bestScore) {
                                found = foundList[i];
                                bestScore = currentScore;
                            }
                        }
                    }
                } else {
                    // Just pick the first one
                    found = foundList.find(f => f !== undefined);
                }
            }

            // If still not found, try looking on the path using jupyter
            if (!found && this.supportsSearchingForCommands()) {
                found = await this.findPathCommand(command, cancelToken);
            }

            // If we found a command, save in our dictionary
            if (found) {
                this.commands[command] = found;
            }
        }

        // Return result
        return this.commands.hasOwnProperty(command) ? this.commands[command] : undefined;
    }

    private doesModuleExist = async (module: string, interpreter: PythonInterpreter, cancelToken?: CancellationToken): Promise<boolean> => {
        if (interpreter && interpreter !== null) {
            const newOptions: SpawnOptions = { throwOnStdErr: true, encoding: 'utf8', token: cancelToken };
            const pythonService = await this.executionFactory.createActivatedEnvironment({ resource: undefined, interpreter });
            try {
                // Special case for ipykernel
                const actualModule = module === JupyterCommands.KernelCreateCommand ? module : 'jupyter';
                const args = module === JupyterCommands.KernelCreateCommand ? ['--version'] : [module, '--version'];

                const result = await pythonService.execModule(actualModule, args, newOptions);
                return !result.stderr;
            } catch (err) {
                this.logger.logWarning(`${err} for ${interpreter.path}`);
                return false;
            }
        } else {
            return false;
        }
    }

    private doesJupyterCommandExist = async (command?: string, cancelToken?: CancellationToken): Promise<boolean> => {
        const newOptions: SpawnOptions = { throwOnStdErr: true, encoding: 'utf8', token: cancelToken };
        const args = command ? [command, '--version'] : ['--version'];
        const processService = await this.processServicePromise;
        try {
            const result = await processService.exec('jupyter', args, newOptions);
            return !result.stderr;
        } catch (err) {
            this.logger.logWarning(err);
            return false;
        }
    }

}
