{
  description = "Phib, a cellular-automaton language";

  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    {
      flake-utils,
      nixpkgs,
      self,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        quilt = pkgs.callPackage ./nix/quilt.nix { };
      in
      {
        packages.quilt = quilt;

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.python3
            pkgs.uv
            quilt
          ];
          # Use the shell's Python, never download one.
          UV_PYTHON_DOWNLOADS = "never";
        };
      }
    );
}
