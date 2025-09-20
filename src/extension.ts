import * as vscode from "vscode";
import * as path from "path";

interface StepDefinitionConfig {
  packageName: string;
  className: string;
  baseTestClass: string;
  imports: string[];
  annotations: string[];
  framework: 'cucumber' | 'testng' | 'junit';
}

interface ParsedStep {
  originalStep: string;
  annotation: string;
  stepText: string;
  parameters: string[];
  methodName: string;
  parameterizedRegex: string;
}

export function activate(context: vscode.ExtensionContext) {
  // Register main command
  let generateStepCommand = vscode.commands.registerCommand(
    "cucumberStepGen.generateStep",
    async () => await generateStepDefinitions()
  );

  // Register configuration command
  let configCommand = vscode.commands.registerCommand(
    "cucumberStepGen.configure",
    async () => await showConfigurationDialog()
  );

  // Register create step definition file command
  let createFileCommand = vscode.commands.registerCommand(
    "cucumberStepGen.createStepFile",
    async () => await createStepDefinitionFile()
  );

  // Register quick actions command
  let quickActionsCommand = vscode.commands.registerCommand(
    "cucumberStepGen.quickActions",
    async () => await showQuickActions()
  );

  context.subscriptions.push(generateStepCommand, configCommand, createFileCommand, quickActionsCommand);

  // Create status bar item with enhanced functionality
  const stepDefButton = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  stepDefButton.command = "cucumberStepGen.quickActions";
  stepDefButton.text = "$(code) Cucumber Steps";
  stepDefButton.tooltip = "Cucumber Step Definition Generator - Click for quick actions";
  stepDefButton.show();

  context.subscriptions.push(stepDefButton);

  // Register context menu commands
  context.subscriptions.push(
    vscode.commands.registerCommand('cucumberStepGen.generateFromSelection', async () => {
      await generateStepDefinitions(true);
    })
  );

  // Initialize configuration if not exists
  initializeConfiguration();
}

async function showQuickActions() {
  const actions = [
    {
      label: "$(code) Generate Step Definitions",
      description: "Generate step definitions from current file or selection",
      action: "generate"
    },
    {
      label: "$(file-add) Create Step Definition File",
      description: "Create a new step definition file",
      action: "createFile"
    },
    {
      label: "$(gear) Configure Settings",
      description: "Configure generation settings",
      action: "configure"
    },
    {
      label: "$(info) About Extension",
      description: "View extension information",
      action: "about"
    }
  ];

  const selected = await vscode.window.showQuickPick(actions, {
    placeHolder: "Select an action",
    matchOnDescription: true
  });

  if (selected) {
    switch (selected.action) {
      case "generate":
        await generateStepDefinitions();
        break;
      case "createFile":
        await createStepDefinitionFile();
        break;
      case "configure":
        await showConfigurationDialog();
        break;
      case "about":
        await showAboutDialog();
        break;
    }
  }
}

async function generateStepDefinitions(selectionOnly = false) {
  try {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("❌ No active editor found. Please open a Cucumber feature file.");
      return;
    }

    const document = editor.document;

    // Validate file type
    if (!isValidCucumberFile(document)) {
      const proceed = await vscode.window.showWarningMessage(
        "⚠️ This doesn't appear to be a Cucumber feature file. Continue anyway?",
        "Yes", "No"
      );
      if (proceed !== "Yes") { return; }
    }

    // Show progress
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Generating Step Definitions",
      cancellable: false
    }, async (progress) => {
      progress.report({ increment: 10, message: "Parsing steps..." });

      let textToProcess = "";
      let selectionInfo = "";

      if (selectionOnly || !editor.selection.isEmpty) {
        const selection = editor.selection;
        textToProcess = document.getText(selection).trim();
        selectionInfo = ` (${selection.end.line - selection.start.line + 1} lines selected)`;
      } else {
        textToProcess = document.getText();
        selectionInfo = " (entire file)";
      }

      progress.report({ increment: 30, message: "Processing steps..." });

      if (!textToProcess) {
        vscode.window.showWarningMessage("No content to process.");
        return;
      }

      const lines = textToProcess.split("\n").map(line => line.trim());
      const validSteps = getValidCucumberSteps(lines);

      if (validSteps.length === 0) {
        vscode.window.showWarningMessage(
          `No valid Cucumber steps found${selectionInfo}. Make sure your steps start with Given, When, Then, or And.`
        );
        return;
      }

      progress.report({ increment: 40, message: "Generating code..." });

      const config = getConfiguration();
      const stepDefinitions = await generateAdvancedStepDefinitions(validSteps, config);

      progress.report({ increment: 80, message: "Copying to clipboard..." });

      // Copy to clipboard
      await vscode.env.clipboard.writeText(stepDefinitions);

      progress.report({ increment: 100, message: "Complete!" });

      // Show success message with options
      const action = await vscode.window.showInformationMessage(
        `✅ Generated ${validSteps.length} step definition(s)${selectionInfo} and copied to clipboard!`,
        "Create File", "View Output", "Configure"
      );

      if (action === "Create File") {
        await createStepDefinitionFile(stepDefinitions);
      } else if (action === "View Output") {
        await showOutputPreview(stepDefinitions);
      } else if (action === "Configure") {
        await showConfigurationDialog();
      }
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    vscode.window.showErrorMessage(`❌ Error generating step definitions: ${errorMessage}`);
    console.error("Step generation error:", error);
  }
}

function isValidCucumberFile(document: vscode.TextDocument): boolean {
  const fileName = path.basename(document.fileName).toLowerCase();
  const fileContent = document.getText();

  return fileName.endsWith('.feature') ||
    /^\s*(Feature:|Scenario:|Given|When|Then|And)/m.test(fileContent);
}

function getValidCucumberSteps(lines: string[]): string[] {
  const stepKeywords = /^(Given|When|Then|And|But)\s+/;
  const steps = new Set<string>();

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines, comments, and non-step lines
    if (!trimmedLine ||
      trimmedLine.startsWith('#') ||
      trimmedLine.startsWith('Feature:') ||
      trimmedLine.startsWith('Scenario:') ||
      trimmedLine.startsWith('Background:') ||
      trimmedLine.startsWith('Examples:') ||
      trimmedLine.startsWith('|')) {
      continue;
    }

    if (stepKeywords.test(trimmedLine)) {
      // Normalize "And" and "But" to the appropriate step type based on context
      let normalizedStep = trimmedLine;
      if (trimmedLine.startsWith('And ') || trimmedLine.startsWith('But ')) {
        // For simplicity, convert And/But to Given (can be enhanced with context awareness)
        normalizedStep = trimmedLine.replace(/^(And|But)\s+/, 'Given ');
      }
      steps.add(normalizedStep);
    }
  }

  return Array.from(steps);
}

async function generateAdvancedStepDefinitions(steps: string[], config: StepDefinitionConfig): Promise<string> {
  const parsedSteps = steps.map(step => parseStep(step));
  const methodNames = new Set<string>();

  let code = generateClassHeader(config);

  const stepDefinitions = parsedSteps.map(parsedStep => {
    if (!parsedStep) { return ""; }

    const stepDef = generateAdvancedStepDefinition(parsedStep, methodNames, config);
    return stepDef;
  }).filter(def => def !== "").join("\n\n");

  code += stepDefinitions;
  code += generateClassFooter(config);

  return formatJavaCode(code);
}

function parseStep(step: string): ParsedStep | null {
  const matches = step.match(/^(Given|When|Then|And|But)\s+(.*)$/);
  if (!matches) { return null; }

  const annotation = matches[1] === 'And' || matches[1] === 'But' ? 'Given' : matches[1];
  const stepText = matches[2];

  // Extract parameters from quotes and angle brackets
  const parameters: string[] = [];
  let parameterizedRegex = stepText;

  // Handle quoted parameters
  parameterizedRegex = parameterizedRegex.replace(/"([^"]*)"/g, (match, content) => {
    parameters.push(`String param${parameters.length + 1}`);
    return '"(.*?)"';
  });

  // Handle angle bracket parameters
  parameterizedRegex = parameterizedRegex.replace(/<([^>]*)>/g, (match, content) => {
    parameters.push(`String ${content.replace(/\s+/g, '_').toLowerCase()}`);
    return '(.*)';
  });

  // Handle number parameters
  parameterizedRegex = parameterizedRegex.replace(/\b\d+\b/g, (match) => {
    parameters.push(`int number${parameters.length + 1}`);
    return '(\\d+)';
  });

  const methodName = generateMethodName(stepText);

  return {
    originalStep: step,
    annotation,
    stepText,
    parameters,
    methodName,
    parameterizedRegex
  };
}

function generateMethodName(stepText: string): string {
  return stepText
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .map((word, index) =>
      index === 0 ? word.toLowerCase() :
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join('')
    .replace(/^\d+/, '') // Remove leading numbers
    || 'generatedStep';
}

function generateAdvancedStepDefinition(
  parsedStep: ParsedStep,
  methodNames: Set<string>,
  config: StepDefinitionConfig
): string {
  let methodName = parsedStep.methodName;

  // Ensure unique method name
  let counter = 1;
  let uniqueMethodName = methodName;
  while (methodNames.has(uniqueMethodName)) {
    uniqueMethodName = `${methodName}${counter}`;
    counter++;
  }
  methodNames.add(uniqueMethodName);

  const parameters = parsedStep.parameters.join(', ');
  const parametersList = parsedStep.parameters.length > 0 ? parameters : '';

  let stepDefinition = '';

  // Add method documentation
  stepDefinition += `    /**\n`;
  stepDefinition += `     * Step: ${parsedStep.originalStep}\n`;
  if (parsedStep.parameters.length > 0) {
    stepDefinition += `     * Parameters: ${parsedStep.parameters.length}\n`;
  }
  stepDefinition += `     */\n`;

  // Add annotation
  stepDefinition += `    @${parsedStep.annotation}("^${parsedStep.parameterizedRegex}$")\n`;

  // Add method signature
  stepDefinition += `    public void ${uniqueMethodName}(${parametersList}) {\n`;

  // Add method body with enhanced template
  stepDefinition += `        try {\n`;
  stepDefinition += `            // TODO: Implement step logic for: ${parsedStep.stepText}\n`;

  if (parsedStep.parameters.length > 0) {
    stepDefinition += `            // Available parameters:\n`;
    parsedStep.parameters.forEach((param, index) => {
      stepDefinition += `            //   ${param}\n`;
    });
  }

  // Add common Selenium patterns based on step type
  stepDefinition += generateStepTemplate(parsedStep.annotation, parsedStep.stepText);

  stepDefinition += `            \n`;
  stepDefinition += `            // Add assertions for verification\n`;
  stepDefinition += `            // Assert.assertTrue("Step verification failed", condition);\n`;
  stepDefinition += `            \n`;
  stepDefinition += `        } catch (Exception e) {\n`;
  stepDefinition += `            throw new RuntimeException("Failed to execute step: ${parsedStep.stepText}", e);\n`;
  stepDefinition += `        }\n`;
  stepDefinition += `    }`;

  return stepDefinition;
}

function generateStepTemplate(annotation: string, stepText: string): string {
  let template = '';
  const lowerStepText = stepText.toLowerCase();

  switch (annotation.toLowerCase()) {
    case 'given':
      template += `            // Setup/precondition logic\n`;
      if (lowerStepText.includes('navigate') || lowerStepText.includes('open')) {
        template += `            // driver.get("URL");\n`;
      } else if (lowerStepText.includes('login') || lowerStepText.includes('user')) {
        template += `            // Perform login or user setup\n`;
      } else {
        template += `            // Setup test data or initial state\n`;
      }
      break;

    case 'when':
      template += `            // Action/interaction logic\n`;
      if (lowerStepText.includes('click')) {
        template += `            // WebElement element = driver.findElement(By.id("elementId"));\n`;
        template += `            // element.click();\n`;
      } else if (lowerStepText.includes('enter') || lowerStepText.includes('input')) {
        template += `            // WebElement inputField = driver.findElement(By.id("inputId"));\n`;
        template += `            // inputField.sendKeys("value");\n`;
      } else if (lowerStepText.includes('select')) {
        template += `            // Select dropdown = new Select(driver.findElement(By.id("selectId")));\n`;
        template += `            // dropdown.selectByVisibleText("optionText");\n`;
      } else {
        template += `            // Perform the main action\n`;
      }
      break;

    case 'then':
      template += `            // Verification/assertion logic\n`;
      if (lowerStepText.includes('should see') || lowerStepText.includes('displayed')) {
        template += `            // WebElement element = driver.findElement(By.id("elementId"));\n`;
        template += `            // Assert.assertTrue("Element should be displayed", element.isDisplayed());\n`;
      } else if (lowerStepText.includes('text') || lowerStepText.includes('contains')) {
        template += `            // String actualText = driver.findElement(By.id("elementId")).getText();\n`;
        template += `            // Assert.assertTrue("Text verification failed", actualText.contains("expectedText"));\n`;
      } else {
        template += `            // Verify the expected outcome\n`;
      }
      break;

    default:
      template += `            // Implement step logic\n`;
  }

  return template;
}

function generateClassHeader(config: StepDefinitionConfig): string {
  let header = '';

  // Package declaration
  if (config.packageName) {
    header += `package ${config.packageName};\n\n`;
  }

  // Imports
  const defaultImports = [
    'io.cucumber.java.en.Given',
    'io.cucumber.java.en.When',
    'io.cucumber.java.en.Then',
    'org.openqa.selenium.WebDriver',
    'org.openqa.selenium.WebElement',
    'org.openqa.selenium.By',
    'org.openqa.selenium.support.ui.Select',
    'org.openqa.selenium.support.ui.WebDriverWait',
    'org.testng.Assert',
    'java.time.Duration'
  ];

  const allImports = [...new Set([...defaultImports, ...config.imports])];
  allImports.forEach(imp => {
    header += `import ${imp};\n`;
  });

  header += '\n';

  // Class declaration with javadoc
  header += `/**\n`;
  header += ` * Cucumber Step Definitions\n`;
  header += ` * Generated by Selenium-Cucumber Extension\n`;
  header += ` * \n`;
  header += ` * This class contains step definitions for Cucumber scenarios.\n`;
  header += ` * Each method represents a step that can be used in feature files.\n`;
  header += ` */\n`;

  if (config.baseTestClass) {
    header += `public class ${config.className} extends ${config.baseTestClass} {\n\n`;
  } else {
    header += `public class ${config.className} {\n\n`;
  }

  // Class-level fields and constructor
  header += `    private WebDriver driver;\n`;
  header += `    private WebDriverWait wait;\n\n`;

  header += `    public ${config.className}() {\n`;
  header += `        // Initialize WebDriver and WebDriverWait if needed\n`;
  header += `        // this.driver = DriverManager.getDriver();\n`;
  header += `        // this.wait = new WebDriverWait(driver, Duration.ofSeconds(10));\n`;
  header += `    }\n\n`;

  return header;
}

function generateClassFooter(config: StepDefinitionConfig): string {
  let footer = '\n';

  // Helper methods
  footer += `    /**\n`;
  footer += `     * Helper method to find element with wait\n`;
  footer += `     */\n`;
  footer += `    private WebElement findElementWithWait(By locator) {\n`;
  footer += `        return wait.until(driver -> driver.findElement(locator));\n`;
  footer += `    }\n\n`;

  footer += `    /**\n`;
  footer += `     * Helper method to verify element is displayed\n`;
  footer += `     */\n`;
  footer += `    private boolean isElementDisplayed(By locator) {\n`;
  footer += `        try {\n`;
  footer += `            return driver.findElement(locator).isDisplayed();\n`;
  footer += `        } catch (Exception e) {\n`;
  footer += `            return false;\n`;
  footer += `        }\n`;
  footer += `    }\n`;

  footer += '}\n';

  return footer;
}

function formatJavaCode(code: string): string {
  // Basic Java code formatting
  const lines = code.split('\n');
  let indentLevel = 0;
  const indentSize = 4;

  const formattedLines = lines.map(line => {
    const trimmed = line.trim();

    if (!trimmed) { return ''; }

    // Decrease indent for closing braces
    if (trimmed === '}' || trimmed.startsWith('} ')) {
      indentLevel = Math.max(0, indentLevel - 1);
    }

    const indentedLine = ' '.repeat(indentLevel * indentSize) + trimmed;

    // Increase indent for opening braces
    if (trimmed.endsWith('{')) {
      indentLevel++;
    }

    return indentedLine;
  });

  return formattedLines.join('\n');
}

function getConfiguration(): StepDefinitionConfig {
  const config = vscode.workspace.getConfiguration('cucumberStepGen');

  return {
    packageName: config.get('packageName', 'com.example.stepdefinitions'),
    className: config.get('className', 'StepDefinitions'),
    baseTestClass: config.get('baseTestClass', ''),
    imports: config.get('imports', []),
    annotations: config.get('annotations', []),
    framework: config.get('framework', 'cucumber')
  };
}

function initializeConfiguration() {
  const config = vscode.workspace.getConfiguration('cucumberStepGen');

  // Set default values if not configured
  if (!config.has('packageName')) {
    config.update('packageName', 'com.example.stepdefinitions', vscode.ConfigurationTarget.Global);
  }

  if (!config.has('className')) {
    config.update('className', 'StepDefinitions', vscode.ConfigurationTarget.Global);
  }
}

async function showConfigurationDialog() {
  const config = getConfiguration();

  const packageName = await vscode.window.showInputBox({
    prompt: 'Enter package name',
    value: config.packageName,
    placeHolder: 'com.example.stepdefinitions'
  });

  if (packageName === undefined) { return; }

  const className = await vscode.window.showInputBox({
    prompt: 'Enter class name',
    value: config.className,
    placeHolder: 'StepDefinitions'
  });

  if (className === undefined) { return; }

  const baseClass = await vscode.window.showInputBox({
    prompt: 'Enter base test class (optional)',
    value: config.baseTestClass,
    placeHolder: 'BaseTest'
  });

  // Update configuration
  const vsConfig = vscode.workspace.getConfiguration('cucumberStepGen');
  await vsConfig.update('packageName', packageName, vscode.ConfigurationTarget.Global);
  await vsConfig.update('className', className, vscode.ConfigurationTarget.Global);
  await vsConfig.update('baseTestClass', baseClass || '', vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage('✅ Configuration updated successfully!');
}

async function createStepDefinitionFile(content?: string) {
  if (!content) {
    content = await generateDefaultStepDefinitionFile();
  }

  const fileName = await vscode.window.showInputBox({
    prompt: 'Enter file name',
    value: 'StepDefinitions.java',
    placeHolder: 'StepDefinitions.java'
  });

  if (!fileName) { return; }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showErrorMessage('No workspace folder found. Please open a folder first.');
    return;
  }

  const filePath = path.join(workspaceFolders[0].uri.fsPath, fileName);
  const uri = vscode.Uri.file(filePath);

  try {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    vscode.window.showInformationMessage(`✅ Step definition file created: ${fileName}`);
  } catch (error) {
    vscode.window.showErrorMessage(`❌ Failed to create file: ${error}`);
  }
}

async function generateDefaultStepDefinitionFile(): Promise<string> {
  const config = getConfiguration();
  const defaultSteps = [
    'Given I am on the homepage',
    'When I click on the login button',
    'Then I should see the login form'
  ];

  return await generateAdvancedStepDefinitions(defaultSteps, config);
}

async function showOutputPreview(content: string) {
  const document = await vscode.workspace.openTextDocument({
    content: content,
    language: 'java'
  });

  await vscode.window.showTextDocument(document, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside
  });
}

async function showAboutDialog() {
  const message = `
🥒 Selenium-Cucumber Extension

Version: 1.0.0
Author: Gyana Prakash Khandual

Features:
✅ Generate step definitions from Cucumber steps
✅ Support for parameterized steps
✅ Configurable package and class names
✅ Professional code formatting
✅ Error handling and validation
✅ Quick actions and shortcuts

Support: github.com/gyanaprakashkhandual/selenium-cucumber-extension
  `.trim();

  vscode.window.showInformationMessage(message, { modal: true });
}

export function deactivate() {
  // Cleanup if needed
}