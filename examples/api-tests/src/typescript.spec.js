// *****************************************************************************
// Copyright (C) 2020 TypeFox and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
// *****************************************************************************

// @ts-check
describe('TypeScript', function () {
    this.timeout(30_000);

    const { assert } = chai;

    const Uri = require('@theia/core/lib/common/uri');
    const { DisposableCollection } = require('@theia/core/lib/common/disposable');
    const { BrowserMainMenuFactory } = require('@theia/core/lib/browser/menu/browser-menu-plugin');
    const { EditorManager } = require('@theia/editor/lib/browser/editor-manager');
    const { EditorWidget } = require('@theia/editor/lib/browser/editor-widget');
    const { EDITOR_CONTEXT_MENU } = require('@theia/editor/lib/browser/editor-menu');
    const { WorkspaceService } = require('@theia/workspace/lib/browser/workspace-service');
    const { MonacoEditor } = require('@theia/monaco/lib/browser/monaco-editor');
    const { HostedPluginSupport } = require('@theia/plugin-ext/lib/hosted/browser/hosted-plugin');
    const { ContextKeyService } = require('@theia/core/lib/browser/context-key-service');
    const { CommandRegistry } = require('@theia/core/lib/common/command');
    const { KeybindingRegistry } = require('@theia/core/lib/browser/keybinding');
    const { OpenerService, open } = require('@theia/core/lib/browser/opener-service');
    const { animationFrame } = require('@theia/core/lib/browser/browser');
    const { PreferenceService, PreferenceScope } = require('@theia/core/lib/browser/preferences/preference-service');
    const { ProgressStatusBarItem } = require('@theia/core/lib/browser/progress-status-bar-item');
    const { PluginViewRegistry } = require('@theia/plugin-ext/lib/main/browser/view/plugin-view-registry');
    const { Range } = require('@theia/monaco-editor-core/esm/vs/editor/common/core/range');
    const { Selection } = require('@theia/monaco-editor-core/esm/vs/editor/common/core/selection');

    const container = window.theia.container;
    const editorManager = container.get(EditorManager);
    const workspaceService = container.get(WorkspaceService);
    const menuFactory = container.get(BrowserMainMenuFactory);
    const pluginService = container.get(HostedPluginSupport);
    const contextKeyService = container.get(ContextKeyService);
    const commands = container.get(CommandRegistry);
    const openerService = container.get(OpenerService);
    /** @type {KeybindingRegistry} */
    const keybindings = container.get(KeybindingRegistry);
    /** @type {import('@theia/core/lib/browser/preferences/preference-service').PreferenceService} */
    const preferences = container.get(PreferenceService);
    const progressStatusBarItem = container.get(ProgressStatusBarItem);
    /** @type {PluginViewRegistry} */
    const pluginViewRegistry = container.get(PluginViewRegistry);

    const typescriptPluginId = 'vscode.typescript-language-features';
    const referencesPluginId = 'ms-vscode.references-view';
    /** @type Uri.URI */
    const rootUri = workspaceService.tryGetRoots()[0].resource;
    const demoFileUri = rootUri.resolveToAbsolute('../api-tests/test-ts-workspace/demo-file.ts');
    const definitionFileUri = rootUri.resolveToAbsolute('../api-tests/test-ts-workspace/demo-definitions-file.ts');
    let originalAutoSaveValue = preferences.get('files.autoSave', undefined, rootUri.toString());

    before(async function () {
        await pluginService.didStart;
        await Promise.all([typescriptPluginId, referencesPluginId].map(async pluginId => {
            if (!pluginService.getPlugin(pluginId)) {
                throw new Error(pluginId + ' should be started');
            }
            await pluginService.activatePlugin(pluginId);
        }).concat(preferences.set('files.autoSave', 'off', PreferenceScope.Workspace)));
    });

    beforeEach(async function () {
        await editorManager.closeAll({ save: false });
    });

    const toTearDown = new DisposableCollection();
    afterEach(async () => {
        toTearDown.dispose();
        await editorManager.closeAll({ save: false });
    });

    after(async () => {
        await preferences.set('files.autoSave', originalAutoSaveValue, PreferenceScope.Workspace);
    })

    /**
     * @param {Uri.default} uri
     * @param {boolean} preview
     */
    async function openEditor(uri, preview = false) {
        const widget = await open(openerService, uri, { mode: 'activate', preview });
        const editorWidget = widget instanceof EditorWidget ? widget : undefined;
        const editor = MonacoEditor.get(editorWidget);
        assert.isDefined(editor);
        // wait till tsserver is running, see:
        // https://github.com/microsoft/vscode/blob/93cbbc5cae50e9f5f5046343c751b6d010468200/extensions/typescript-language-features/src/extension.ts#L98-L103
        await waitForAnimation(() => contextKeyService.match('typescript.isManagedFile'));
        // wait till projects are loaded, see:
        // https://github.com/microsoft/vscode/blob/4aac84268c6226d23828cc6a1fe45ee3982927f0/extensions/typescript-language-features/src/typescriptServiceClient.ts#L911
        await waitForAnimation(() => !progressStatusBarItem.currentProgress);
        return /** @type {MonacoEditor} */ (editor);
    }

    /**
     * @param {() => Promise<unknown> | unknown} condition
     * @param {number | undefined} [timeout]
     * @param {string | undefined} [message]
     * @returns {Promise<void>}
     */
    function waitForAnimation(condition, timeout, message) {
        const success = new Promise(async (resolve, reject) => {
            toTearDown.push({ dispose: () => reject(message ?? 'Test terminated before resolution.') });
            do {
                await animationFrame();
            } while (!condition());
            resolve();
        });
        if (timeout !== undefined) {
            const timedOut = new Promise((_, fail) => {
                const toClear = setTimeout(() => fail(new Error(message ?? 'Wait for animation timed out.')), timeout);
                toTearDown.push({ dispose: () => (fail(new Error(message ?? 'Wait for animation timed out.')), clearTimeout(toClear)) });
            });
            return Promise.race([success, timedOut]);
        }
        return success;
    }

    /**
     * We ignore attributes on purpose since they are not stable.
     * But structure is important for us to see whether the plain text is rendered or markdown.
     *
     * @param {Element} element
     * @returns {string}
     */
    function nodeAsString(element, indentation = '') {
        const header = element.tagName;
        let body = '';
        const childIndentation = indentation + '  ';
        for (let i = 0; i < element.childNodes.length; i++) {
            const childNode = element.childNodes.item(i);
            if (childNode.nodeType === childNode.TEXT_NODE) {
                body += childIndentation + `"${childNode.textContent}"` + '\n';
            } else if (childNode instanceof HTMLElement) {
                body += childIndentation + nodeAsString(childNode, childIndentation) + '\n';
            }
        }
        const result = header + (body ? ' {\n' + body + indentation + '}' : '');
        if (indentation) {
            return result;
        }
        return `\n${result}\n`;
    }

    /**
     * @param {MonacoEditor} editor
     */
    async function assertPeekOpened(editor) {
        /** @type any */
        const referencesController = editor.getControl().getContribution('editor.contrib.referencesController');
        await waitForAnimation(() => referencesController._widget && referencesController._widget._tree.getFocus().length);

        assert.isFalse(contextKeyService.match('editorTextFocus'));
        assert.isTrue(contextKeyService.match('referenceSearchVisible'));
        assert.isTrue(contextKeyService.match('listFocus'));
    }

    /**
     * @param {MonacoEditor} editor
     */
    async function openPeek(editor) {
        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('referenceSearchVisible'));
        assert.isFalse(contextKeyService.match('listFocus'));

        await commands.executeCommand('editor.action.peekDefinition');
        await assertPeekOpened(editor);
    }

    async function openReference() {
        keybindings.dispatchKeyDown('Enter');
        await waitForAnimation(() => contextKeyService.match('listFocus'));
        assert.isFalse(contextKeyService.match('editorTextFocus'));
        assert.isTrue(contextKeyService.match('referenceSearchVisible'));
        assert.isTrue(contextKeyService.match('listFocus'));
    }

    /**
     * @param {MonacoEditor} editor
     */
    async function closePeek(editor) {
        await assertPeekOpened(editor);

        keybindings.dispatchKeyDown('Escape');
        await waitForAnimation(() => !contextKeyService.match('listFocus'));
        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('referenceSearchVisible'));
        assert.isFalse(contextKeyService.match('listFocus'));
    }

    it('document formatting should be visible and enabled', async function () {
        await openEditor(demoFileUri);
        const menu = menuFactory.createContextMenu(EDITOR_CONTEXT_MENU);
        const item = menu.items.find(i => i.command === 'editor.action.formatDocument');
        if (item) {
            assert.isTrue(item.isVisible);
            assert.isTrue(item.isEnabled);
        } else {
            assert.isDefined(item);
        }
    });

    describe('editor.action.revealDefinition', function () {
        for (const preview of [false, true]) {
            const from = 'an editor' + (preview ? ' preview' : '');
            it('within ' + from, async function () {
                const editor = await openEditor(demoFileUri, preview);
                // const demoInstance = new Demo|Class('demo');
                editor.getControl().setPosition({ lineNumber: 24, column: 30 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'DemoClass');

                await commands.executeCommand('editor.action.revealDefinition');

                const activeEditor = /** @type {MonacoEditor} */ MonacoEditor.get(editorManager.activeEditor);
                assert.equal(editorManager.activeEditor.isPreview, preview);
                assert.equal(activeEditor.uri.toString(), demoFileUri.toString());
                // constructor(someString: string) {
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 11, column: 5 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'constructor');
            });

            it(`from ${from} to another editor`, async function () {
                await editorManager.open(definitionFileUri, { mode: 'open' });

                const editor = await openEditor(demoFileUri, preview);
                // const bar: Defined|Interface = { coolField: [] };
                editor.getControl().setPosition({ lineNumber: 32, column: 19 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'DefinedInterface');

                await commands.executeCommand('editor.action.revealDefinition');

                const activeEditor = /** @type {MonacoEditor} */ MonacoEditor.get(editorManager.activeEditor);
                assert.isFalse(editorManager.activeEditor.isPreview);
                assert.equal(activeEditor.uri.toString(), definitionFileUri.toString());

                // export interface |DefinedInterface {
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 2, column: 18 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'DefinedInterface');
            });

            it(`from ${from} to an editor preview`, async function () {
                const editor = await openEditor(demoFileUri);
                // const bar: Defined|Interface = { coolField: [] };
                editor.getControl().setPosition({ lineNumber: 32, column: 19 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'DefinedInterface');

                await commands.executeCommand('editor.action.revealDefinition');

                const activeEditor = /** @type {MonacoEditor} */ MonacoEditor.get(editorManager.activeEditor);
                assert.isTrue(editorManager.activeEditor.isPreview);
                assert.equal(activeEditor.uri.toString(), definitionFileUri.toString());
                // export interface |DefinedInterface {
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 2, column: 18 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'DefinedInterface');
            });
        }
    });

    describe('editor.action.peekDefinition', function () {

        for (const preview of [false, true]) {
            const from = 'an editor' + (preview ? ' preview' : '');
            it('within ' + from, async function () {
                const editor = await openEditor(demoFileUri, preview);
                editor.getControl().revealLine(24);
                // const demoInstance = new Demo|Class('demo');
                editor.getControl().setPosition({ lineNumber: 24, column: 30 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'DemoClass');

                await openPeek(editor);
                await openReference();

                const activeEditor = /** @type {MonacoEditor} */ MonacoEditor.get(editorManager.activeEditor);
                assert.equal(editorManager.activeEditor.isPreview, preview);
                assert.equal(activeEditor.uri.toString(), demoFileUri.toString());
                // constructor(someString: string) {
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 11, column: 5 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'constructor');

                await closePeek(activeEditor);
            });

            it(`from ${from} to another editor`, async function () {
                await editorManager.open(definitionFileUri, { mode: 'open' });

                const editor = await openEditor(demoFileUri, preview);
                editor.getControl().revealLine(32);
                // const bar: Defined|Interface = { coolField: [] };
                editor.getControl().setPosition({ lineNumber: 32, column: 19 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'DefinedInterface');

                await openPeek(editor);
                await openReference();

                const activeEditor = /** @type {MonacoEditor} */ MonacoEditor.get(editorManager.activeEditor);
                assert.isFalse(editorManager.activeEditor.isPreview);
                assert.equal(activeEditor.uri.toString(), definitionFileUri.toString());
                // export interface |DefinedInterface {
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 2, column: 18 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'DefinedInterface');

                await closePeek(activeEditor);
            });

            it(`from ${from} to an editor preview`, async function () {
                const editor = await openEditor(demoFileUri);
                editor.getControl().revealLine(32);
                // const bar: Defined|Interface = { coolField: [] };
                editor.getControl().setPosition({ lineNumber: 32, column: 19 });
                assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'DefinedInterface');

                await openPeek(editor);
                await openReference();

                const activeEditor = /** @type {MonacoEditor} */ MonacoEditor.get(editorManager.activeEditor);
                assert.isTrue(editorManager.activeEditor.isPreview);
                assert.equal(activeEditor.uri.toString(), definitionFileUri.toString());
                // export interface |DefinedInterface {
                const { lineNumber, column } = activeEditor.getControl().getPosition();
                assert.deepEqual({ lineNumber, column }, { lineNumber: 2, column: 18 });
                assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'DefinedInterface');

                await closePeek(activeEditor);
            });
        }
    });

    it('editor.action.triggerSuggest', async function () {
        const editor = await openEditor(demoFileUri);
        // const demoVariable = demoInstance.[stringField];
        editor.getControl().setPosition({ lineNumber: 26, column: 46 });
        editor.getControl().setSelection(new Selection(26, 46, 26, 35));
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'stringField');

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('suggestWidgetVisible'));

        await commands.executeCommand('editor.action.triggerSuggest');
        await waitForAnimation(() => contextKeyService.match('suggestWidgetVisible'));

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isTrue(contextKeyService.match('suggestWidgetVisible'));

        keybindings.dispatchKeyDown('Enter');
        await waitForAnimation(() => !contextKeyService.match('suggestWidgetVisible'));

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('suggestWidgetVisible'));

        const activeEditor = /** @type {MonacoEditor} */ MonacoEditor.get(editorManager.activeEditor);
        assert.equal(activeEditor.uri.toString(), demoFileUri.toString());
        // demoInstance.stringField;
        const { lineNumber, column } = activeEditor.getControl().getPosition();
        assert.deepEqual({ lineNumber, column }, { lineNumber: 26, column: 46 });
        assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'doSomething');
    });

    it('editor.action.triggerSuggest navigate', async function () {
        const editor = await openEditor(demoFileUri);
        // demoInstance.[|stringField];
        editor.getControl().setPosition({ lineNumber: 26, column: 46 });
        editor.getControl().setSelection(new Selection(26, 46, 26, 35));
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'stringField');

        /** @type {import('@theia/monaco-editor-core/src/vs/editor/contrib/suggest/browser/suggestController').SuggestController} */
        const suggest = editor.getControl().getContribution('editor.contrib.suggestController');
        const getFocusedLabel = () => {
            const focusedItem = suggest.widget.value.getFocusedItem();
            return focusedItem && focusedItem.item.completion.label;
        };

        assert.isUndefined(getFocusedLabel());
        assert.isFalse(contextKeyService.match('suggestWidgetVisible'));

        await commands.executeCommand('editor.action.triggerSuggest');
        await waitForAnimation(() => contextKeyService.match('suggestWidgetVisible') && getFocusedLabel() === 'doSomething', 5000);

        assert.equal(getFocusedLabel(), 'doSomething');
        assert.isTrue(contextKeyService.match('suggestWidgetVisible'));

        keybindings.dispatchKeyDown('ArrowDown');
        await waitForAnimation(() => contextKeyService.match('suggestWidgetVisible') && getFocusedLabel() === 'numberField', 2000);

        assert.equal(getFocusedLabel(), 'numberField');
        assert.isTrue(contextKeyService.match('suggestWidgetVisible'));

        keybindings.dispatchKeyDown('ArrowUp');
        await waitForAnimation(() => contextKeyService.match('suggestWidgetVisible') && getFocusedLabel() === 'doSomething', 2000);

        assert.equal(getFocusedLabel(), 'doSomething');
        assert.isTrue(contextKeyService.match('suggestWidgetVisible'));

        keybindings.dispatchKeyDown('Escape');
        await waitForAnimation(() => !contextKeyService.match('suggestWidgetVisible') && getFocusedLabel() === undefined, 5000);

        assert.isUndefined(getFocusedLabel());
        assert.isFalse(contextKeyService.match('suggestWidgetVisible'));
    });

    it('editor.action.rename', async function () {
        const editor = await openEditor(demoFileUri);
        // const |demoVariable = demoInstance.stringField;
        editor.getControl().setPosition({ lineNumber: 26, column: 7 });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'demoVariable');

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('renameInputVisible'));

        commands.executeCommand('editor.action.rename');
        await waitForAnimation(() => contextKeyService.match('renameInputVisible')
            && document.activeElement instanceof HTMLInputElement
            && document.activeElement.selectionEnd === 'demoVariable'.length);
        assert.isFalse(contextKeyService.match('editorTextFocus'));
        assert.isTrue(contextKeyService.match('renameInputVisible'));

        const input = document.activeElement;
        if (!(input instanceof HTMLInputElement)) {
            assert.fail('expected focused input, but: ' + input);
            return;
        }

        input.value = 'foo';
        keybindings.dispatchKeyDown('Enter', input);

        // all rename edits should be grouped in one edit operation and applied in the same tick
        await new Promise(resolve => editor.getControl().onDidChangeModelContent(resolve));

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('renameInputVisible'));

        const activeEditor = /** @type {MonacoEditor} */ MonacoEditor.get(editorManager.activeEditor);
        assert.equal(activeEditor.uri.toString(), demoFileUri.toString());
        // const |foo = new Container();
        const { lineNumber, column } = activeEditor.getControl().getPosition();
        assert.deepEqual({ lineNumber, column }, { lineNumber: 26, column: 7 });
        assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber: 28, column: 1 }).word, 'foo');
    });

    it('editor.action.triggerParameterHints', async function () {
        const editor = await openEditor(demoFileUri);
        // const demoInstance = new DemoClass('|demo');
        editor.getControl().setPosition({ lineNumber: 24, column: 37 });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, "demo");

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('parameterHintsVisible'));

        await commands.executeCommand('editor.action.triggerParameterHints');
        await waitForAnimation(() => contextKeyService.match('parameterHintsVisible'));

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isTrue(contextKeyService.match('parameterHintsVisible'));

        keybindings.dispatchKeyDown('Escape');
        await waitForAnimation(() => !contextKeyService.match('parameterHintsVisible'));

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(contextKeyService.match('parameterHintsVisible'));
    });

    it('editor.action.showHover', async function () {
        const editor = await openEditor(demoFileUri);
        // class |DemoClass);
        editor.getControl().setPosition({ lineNumber: 8, column: 7 });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'DemoClass');

        /** @type {import('@theia/monaco-editor-core/src/vs/editor/contrib/hover/browser/hover').ModesHoverController} */
        const hover = editor.getControl().getContribution('editor.contrib.hover');

        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(Boolean(hover['_contentWidget']?.['_widget']?.['_visibleData']));
        await commands.executeCommand('editor.action.showHover');
        let doLog = true;
        await waitForAnimation(() => hover['_contentWidget']?.['_widget']?.['_visibleData']);
        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isTrue(Boolean(hover['_contentWidget']?.['_widget']?.['_visibleData']));
        assert.deepEqual(nodeAsString(hover['_contentWidget']?.['_widget']?.['_hover']?.['contentsDomNode']).trim(), `
DIV {
  DIV {
    DIV {
      DIV {
        DIV {
          SPAN {
            DIV {
              SPAN {
                "class"
              }
              SPAN {
                " "
              }
              SPAN {
                "DemoClass"
              }
            }
          }
        }
      }
    }
  }
}`.trim());
        keybindings.dispatchKeyDown('Escape');
        await waitForAnimation(() => !hover['_contentWidget']?.['_widget']?.['_visibleData']);
        assert.isTrue(contextKeyService.match('editorTextFocus'));
        assert.isFalse(Boolean(hover['_contentWidget']?.['_widget']?.['_visibleData']));
    });

    it('highlight semantic (write) occurrences', async function () {
        const editor = await openEditor(demoFileUri);
        // const |container = new Container();
        const lineNumber = 24;
        const column = 7;
        const endColumn = column + 'demoInstance'.length;

        const hasWriteDecoration = () => {
            for (const decoration of editor.getControl().getModel().getLineDecorations(lineNumber)) {
                if (decoration.range.startColumn === column && decoration.range.endColumn === endColumn && decoration.options.className === 'wordHighlightStrong') {
                    return true;
                }
            }
            return false;
        };
        assert.isFalse(hasWriteDecoration());

        editor.getControl().setPosition({ lineNumber, column });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'demoInstance');
        // highlight occurrences is not trigged on the explicit position change, so move a cursor as a user
        keybindings.dispatchKeyDown('ArrowRight');
        await waitForAnimation(() => hasWriteDecoration());

        assert.isTrue(hasWriteDecoration());
    });

    it('editor.action.goToImplementation', async function () {
        const editor = await openEditor(demoFileUri);
        // const demoInstance = new Demo|Class('demo');
        editor.getControl().setPosition({ lineNumber: 24, column: 30 });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'DemoClass');

        await commands.executeCommand('editor.action.goToImplementation');

        const activeEditor = /** @type {MonacoEditor} */ MonacoEditor.get(editorManager.activeEditor);
        assert.equal(activeEditor.uri.toString(), demoFileUri.toString());
        // class |DemoClass implements DemoInterface {
        const { lineNumber, column } = activeEditor.getControl().getPosition();
        assert.deepEqual({ lineNumber, column }, { lineNumber: 8, column: 7 });
        assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'DemoClass');
    });

    it('editor.action.goToTypeDefinition', async function () {
        const editor = await openEditor(demoFileUri);
        // const demoVariable = demo|Instance.stringField;
        editor.getControl().setPosition({ lineNumber: 26, column: 26 });
        assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'demoInstance');

        await commands.executeCommand('editor.action.goToTypeDefinition');

        const activeEditor = /** @type {MonacoEditor} */ MonacoEditor.get(editorManager.activeEditor);
        assert.equal(activeEditor.uri.toString(), demoFileUri.toString());
        // class |DemoClass implements DemoInterface {
        const { lineNumber, column } = activeEditor.getControl().getPosition();
        assert.deepEqual({ lineNumber, column }, { lineNumber: 8, column: 7 });
        assert.equal(activeEditor.getControl().getModel().getWordAtPosition({ lineNumber, column }).word, 'DemoClass');
    });

    it('run reference code lens', async function () {
        const preferenceName = 'typescript.referencesCodeLens.enabled';
        const globalValue = preferences.inspect(preferenceName).globalValue;
        toTearDown.push({ dispose: () => preferences.set(preferenceName, globalValue, PreferenceScope.User) });
        await preferences.set(preferenceName, false, PreferenceScope.User);

        const editor = await openEditor(demoFileUri);

        /** @type {import('@theia/monaco-editor-core/src/vs/editor/contrib/codelens/browser/codelensController').CodeLensContribution} */
        const codeLens = editor.getControl().getContribution('css.editor.codeLens');
        const codeLensNode = () => codeLens['_lenses'][0]?.['_contentWidget']?.['_domNode'];
        const codeLensNodeVisible = () => {
            const n = codeLensNode();
            return !!n && n.style.visibility !== 'hidden';
        };

        assert.isFalse(codeLensNodeVisible());

        // |interface DemoInterface {
        const position = { lineNumber: 2, column: 1 };
        await preferences.set(preferenceName, true, PreferenceScope.User);

        editor.getControl().revealPosition(position);
        await waitForAnimation(() => codeLensNodeVisible());

        assert.isTrue(codeLensNodeVisible());
        const node = codeLensNode();
        assert.isDefined(node);
        assert.equal(nodeAsString(node), `
SPAN {
  A {
    "1 reference"
  }
}
`);
        const link = node.getElementsByTagName('a').item(0);
        assert.isDefined(link);
        link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await assertPeekOpened(editor);
        await closePeek(editor);
    });

    it('editor.action.quickFix', async function () {
        const column = 45;
        const lineNumber = 26;
        const editor = await openEditor(demoFileUri);
        const currentChar = () => editor.getControl().getModel().getLineContent(lineNumber).charAt(column - 1);

        // const demoVariable = demoInstance.stringField; --> const demoVariable = demoInstance.stringFiel;
        editor.getControl().getModel().applyEdits([{
            range: {
                startLineNumber: lineNumber,
                endLineNumber: lineNumber,
                startColumn: 45,
                endColumn: 46
            },
            forceMoveMarkers: false,
            text: ''
        }]);
        editor.getControl().setPosition({ lineNumber, column });
        editor.getControl().revealPosition({ lineNumber, column });
        assert.equal(currentChar(), ';');

        /** @type {import('@theia/monaco-editor-core/src/vs/editor/contrib/codeAction/browser/codeActionCommands').QuickFixController} */
        const quickFixController = editor.getControl().getContribution('editor.contrib.quickFixController');
        const lightBulbNode = () => {
            const ui = quickFixController['_ui'].rawValue;
            const lightBulb = ui && ui['_lightBulbWidget'].rawValue;
            return lightBulb && lightBulb['_domNode'];
        };
        const lightBulbVisible = () => {
            const node = lightBulbNode();
            return !!node && node.style.visibility !== 'hidden';
        };

        assert.isFalse(lightBulbVisible());
        await waitForAnimation(() => lightBulbVisible());

        await commands.executeCommand('editor.action.quickFix');
        await waitForAnimation(() => !!document.querySelector('.p-Widget.p-Menu'), 5000);
        await animationFrame();

        keybindings.dispatchKeyDown('ArrowDown');
        keybindings.dispatchKeyDown('Enter');

        await waitForAnimation(() => currentChar() === 'd', 5000);
        assert.equal(currentChar(), 'd');

        await waitForAnimation(() => !lightBulbVisible());
        assert.isFalse(lightBulbVisible());
    });

    it('editor.action.formatDocument', async function () {
        const lineNumber = 5;
        const editor = await openEditor(demoFileUri);
        const originalLength = editor.getControl().getModel().getLineLength(lineNumber);

        // doSomething(): number; --> doSomething() : number;
        editor.getControl().getModel().applyEdits([{
            range: Range.fromPositions({ lineNumber, column: 18 }, { lineNumber, column: 18 }),
            forceMoveMarkers: false,
            text: ' '
        }]);

        assert.equal(editor.getControl().getModel().getLineLength(lineNumber), originalLength + 1);

        await commands.executeCommand('editor.action.formatDocument');

        assert.equal(editor.getControl().getModel().getLineLength(lineNumber), originalLength);
    });

    it('editor.action.formatSelection', async function () {
        // doSomething(): number {
        const lineNumber = 15;
        const editor = await openEditor(demoFileUri);
        const originalLength /* 28 */ = editor.getControl().getModel().getLineLength(lineNumber);

        // doSomething(  )  : number {
        editor.getControl().getModel().applyEdits([{
            range: Range.fromPositions({ lineNumber, column: 17 }, { lineNumber, column: 18 }),
            forceMoveMarkers: false,
            text: '  )  '
        }]);

        assert.equal(editor.getControl().getModel().getLineLength(lineNumber), originalLength + 4);

        // [const { Container  }]  = require('inversify');
        editor.getControl().setSelection({ startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 32 });

        await commands.executeCommand('editor.action.formatSelection');

        // [const { Container }]  = require('inversify');
        assert.equal(editor.getControl().getModel().getLineLength(lineNumber), originalLength);
    });

    for (const referenceViewCommand of ['references-view.find', 'references-view.findImplementations']) {
        it(referenceViewCommand, async function () {
            let steps = 0;
            const editor = await openEditor(demoFileUri);
            // const demo|Instance = new DemoClass('demo');
            editor.getControl().setPosition({ lineNumber: 24, column: 11 });
            assert.equal(editor.getControl().getModel().getWordAtPosition(editor.getControl().getPosition()).word, 'demoInstance');
            const view = await pluginViewRegistry.openView('references-view.tree', { reveal: true });
            assert.isDefined(view);
            assert.isTrue(view.isVisible);
            await commands.executeCommand('references-view.clear');
            const expectedMessage = referenceViewCommand === 'references-view.find' ? '2 results in 1 file' : '1 result in 1 file';
            const getResultText = () => view.node.getElementsByClassName('theia-TreeViewInfo').item(0)?.textContent;
            await commands.executeCommand(referenceViewCommand);
            await waitForAnimation(() => getResultText() === expectedMessage, 5000);
            assert.equal(getResultText(), expectedMessage);
        });
    }
});
