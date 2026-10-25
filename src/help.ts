import { Command } from 'commander';
import { getTheme, type Theme } from './theme';

/** Commands shown in help: hidden ones (such as `__complete`) are left out. */
const visibleCommands = (cmd: Command): readonly Command[] => {
  const visible = cmd.createHelp().visibleCommands(cmd);
  return cmd.commands.filter(sub => visible.includes(sub));
};

/**
 * Prints the comprehensive help message for the CLI.
 * Recursively lists all commands, subcommands, and options.
 * @param command The root command to print help for
 * @param theme Color theme to style output with
 */
export const printComprehensiveHelp = (
  command: Command,
  theme: Theme = getTheme()
): void => {
  console.log(
    theme.heading(
      `\n${command.name()} - ${command.description()} v${command.version()}\n`
    )
  );

  const printCommand = (cmd: Command, depth: number = 0) => {
    const indent = '  '.repeat(depth);
    const subIndent = '  '.repeat(depth + 1);

    // Print command signature
    let signature = `${cmd.name()}`;
    if (cmd.alias()) {
      signature += `|${cmd.alias()}`;
    }
    const args = cmd.registeredArguments
      ?.map(arg => {
        return arg.required ? `<${arg.name()}>` : `[${arg.name()}]`;
      })
      .join(' ');
    if (args) {
      signature += ` ${args}`;
    }

    console.log(`${indent}${theme.successBold(signature)}`);
    if (cmd.description()) {
      console.log(`${subIndent}${cmd.description()}`);
    }

    // Print options
    const options = cmd.options;
    if (options && options.length > 0) {
      console.log(`${subIndent}${theme.warning('Options:')}`);
      options.forEach(option => {
        console.log(
          `${subIndent}  ${option.flags.padEnd(25)} ${option.description}`
        );
      });
    }

    // Recursively print subcommands
    const subcommands = visibleCommands(cmd);
    if (subcommands && subcommands.length > 0) {
      if (depth === 0) {
        console.log(`\n${theme.underline('Commands:')}\n`);
      }
      subcommands.forEach(subCmd => {
        printCommand(subCmd, depth + 1);
        console.log(''); // Add spacing between commands
      });
    }
  };

  // Start recursion
  // Note: 'program' itself is the root, usually we want to list its commands.
  // The root command usually doesn't have a name like 'new' unless explicitly set,
  // but here we are passed 'program' which is 'polyman'.

  // We iterate over the top-level commands directly
  visibleCommands(command).forEach(cmd => {
    printCommand(cmd, 0);
    console.log(
      theme.muted('--------------------------------------------------')
    );
  });
};
