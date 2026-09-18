package packs

import (
	"fmt"
	"path/filepath"
	"sort"
)

type LoadError struct {
	Source Source
	Err    error
}

func (e *LoadError) Error() string {
	return fmt.Sprintf("load %s pack %q: %v", e.Source.Kind, displaySourceName(e.Source), e.Err)
}

func (e *LoadError) Unwrap() error { return e.Err }

type Registry struct {
	packs []LoadedPack
	byID  map[string]int
}

func NewRegistry(loaded []LoadedPack) (*Registry, error) {
	ordered := make([]LoadedPack, len(loaded))
	for i, item := range loaded {
		ordered[i] = cloneLoadedPack(item)
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Pack.Metadata.ID == ordered[j].Pack.Metadata.ID {
			return ordered[i].Source.Name < ordered[j].Source.Name
		}
		return ordered[i].Pack.Metadata.ID < ordered[j].Pack.Metadata.ID
	})
	registry := &Registry{packs: ordered, byID: make(map[string]int, len(ordered))}
	for index, item := range ordered {
		id := item.Pack.Metadata.ID
		if previous, exists := registry.byID[id]; exists {
			return nil, validationError(ErrDuplicatePack, "metadata.id", fmt.Sprintf("pack id %q is declared more than once (%q, %q)", id, displaySourceName(ordered[previous].Source), displaySourceName(item.Source)))
		}
		registry.byID[id] = index
	}
	return registry, nil
}

func (r *Registry) Packs() []LoadedPack {
	if r == nil {
		return nil
	}
	out := make([]LoadedPack, len(r.packs))
	for i, item := range r.packs {
		out[i] = cloneLoadedPack(item)
	}
	return out
}

func (r *Registry) FindPack(id string) (LoadedPack, bool) {
	if r == nil {
		return LoadedPack{}, false
	}
	index, ok := r.byID[id]
	if !ok {
		return LoadedPack{}, false
	}
	return cloneLoadedPack(r.packs[index]), true
}

func (r *Registry) Tools(packID string) []NamedTool {
	loaded, ok := r.FindPack(packID)
	if !ok {
		return nil
	}
	ids := sortedKeys(loaded.Pack.Runtime.Tools)
	tools := make([]NamedTool, 0, len(ids))
	for _, id := range ids {
		tools = append(tools, NamedTool{ID: id, Tool: cloneTool(loaded.Pack.Runtime.Tools[id])})
	}
	return tools
}

func (r *Registry) Commands(packID string) []NamedCommand {
	loaded, ok := r.FindPack(packID)
	if !ok {
		return nil
	}
	ids := sortedKeys(loaded.Pack.Commands)
	commands := make([]NamedCommand, 0, len(ids))
	for _, id := range ids {
		commands = append(commands, NamedCommand{ID: id, Command: cloneCommand(loaded.Pack.Commands[id])})
	}
	return commands
}

func (r *Registry) FindTool(packID, toolID string) (Tool, bool) {
	loaded, ok := r.FindPack(packID)
	if !ok {
		return Tool{}, false
	}
	tool, ok := loaded.Pack.Runtime.Tools[toolID]
	if !ok {
		return Tool{}, false
	}
	return cloneTool(tool), true
}

func (r *Registry) FindCommand(packID, commandID string) (Command, bool) {
	loaded, ok := r.FindPack(packID)
	if !ok {
		return Command{}, false
	}
	command, ok := loaded.Pack.Commands[commandID]
	if !ok {
		return Command{}, false
	}
	return cloneCommand(command), true
}

func cloneLoadedPack(item LoadedPack) LoadedPack {
	item.Pack = clonePack(item.Pack)
	return item
}

func clonePack(pack Pack) Pack {
	out := pack
	out.Runtime.Platforms = append([]string(nil), pack.Runtime.Platforms...)
	out.Runtime.Tools = make(map[string]Tool, len(pack.Runtime.Tools))
	for id, tool := range pack.Runtime.Tools {
		out.Runtime.Tools[id] = cloneTool(tool)
	}
	out.Commands = make(map[string]Command, len(pack.Commands))
	for id, command := range pack.Commands {
		out.Commands[id] = cloneCommand(command)
	}
	return out
}

func cloneTool(tool Tool) Tool {
	tool.ExecutableNames = append([]string(nil), tool.ExecutableNames...)
	if tool.VersionProbe != nil {
		probe := *tool.VersionProbe
		probe.Args = append([]string(nil), tool.VersionProbe.Args...)
		tool.VersionProbe = &probe
	}
	if tool.HelpProbes != nil {
		tool.HelpProbes = make(map[string]HelpProbe, len(tool.HelpProbes))
		for id, source := range tool.HelpProbes {
			probe := source
			probe.Args = append([]string(nil), source.Args...)
			tool.HelpProbes[id] = probe
		}
	}
	return tool
}

func cloneCommand(command Command) Command {
	out := command
	if command.Output.Structured != nil {
		structured := *command.Output.Structured
		structured.Fields = append([]StructuredField(nil), command.Output.Structured.Fields...)
		out.Output.Structured = &structured
	}
	out.Inputs = make([]Input, len(command.Inputs))
	for i, input := range command.Inputs {
		out.Inputs[i] = input
		out.Inputs[i].Validation.Enum = append([]string(nil), input.Validation.Enum...)
	}
	out.Argv = make([]Argument, len(command.Argv))
	for i, argument := range command.Argv {
		out.Argv[i] = argument
		if argument.Flag != nil {
			value := *argument.Flag
			out.Argv[i].Flag = &value
		}
		if argument.Switch != nil {
			value := *argument.Switch
			out.Argv[i].Switch = &value
		}
		if argument.Map != nil {
			value := *argument.Map
			value.Values = make(map[string]string, len(argument.Map.Values))
			for key, literal := range argument.Map.Values {
				value.Values[key] = literal
			}
			out.Argv[i].Map = &value
		}
	}
	return out
}

func displaySourceName(source Source) string {
	if source.Kind == SourceExplicitLocal {
		return filepath.Base(source.Name)
	}
	return source.Name
}
