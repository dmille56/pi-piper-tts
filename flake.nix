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
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.typescript
            pkgs.python3
            llm-agents.packages.${system}.pi
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
      });
}
