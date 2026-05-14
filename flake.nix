{
  description = "pi-tts-command development shell";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    llm-agents.url = "github:numtide/llm-agents.nix";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, llm-agents }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        llmPi = llm-agents.packages.${system}.pi;

        devShell = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.typescript
            pkgs.python3
            llmPi
            (pkgs.writeShellScriptBin "pi-vanilla" ''
              #!/usr/bin/env sh
              unset PI_CODING_AGENT_DIR
              command pi "$@"
            '')
          ];

          shellHook = ''
            export PI_CODING_AGENT_DIR="$PWD/.pi-agent"

            mkdir -p "$PI_CODING_AGENT_DIR"

            echo "pi-tts-command dev shell ready: node $(node --version), tsc $(tsc --version), python $(python3 --version 2>&1)"
          '';
        };

        # Real package for `nix shell` (mkShell/`devShells` don't always expose
        # build inputs on PATH in `nix shell -c/--command` the same way).
        piWrapper = pkgs.writeShellScriptBin "pi" ''
          #!/usr/bin/env sh
          export PI_CODING_AGENT_DIR="$PWD/.pi-agent"
          mkdir -p "$PI_CODING_AGENT_DIR"
          exec "${llmPi}/bin/pi" "$@"
        '';

        piVanilla = pkgs.writeShellScriptBin "pi-vanilla" ''
          #!/usr/bin/env sh
          unset PI_CODING_AGENT_DIR
          exec "${llmPi}/bin/pi" "$@"
        '';

        nixShellTools = pkgs.symlinkJoin {
          name = "pi-tts-command-tools";
          paths = [
            pkgs.nodejs_24
            pkgs.typescript
            pkgs.python3
            llmPi
            piVanilla

            # Put this last so it overrides llmPi's /bin/pi symlink.
            piWrapper
          ];
        };
      in {
        devShells.default = devShell;

        # Allow `nix shell` to work.
        packages.default = nixShellTools;
        defaultPackage = nixShellTools;
      });
}
