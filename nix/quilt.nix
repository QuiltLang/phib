# The Quilt CLI (`quilt`), for quilt/gen.sh, which expands Phib's
# `.ts.quilt` sources into static/{anchors,wgsl,print}.js.
#
# Bump the rev here and in quilt/gen.sh's install hint together; the new
# `hash` is `nix flake prefetch github:QuiltLang/quilt/<rev>`.
{
  fetchFromGitHub,
  rustPlatform,
}:

let
  src = fetchFromGitHub {
    owner = "QuiltLang";
    repo = "quilt";
    rev = "89f0e1333d03060c6d6ae45b0df238faa8b68740";
    hash = "sha256-pXmBIfeheY65u7u10xODVTowvLr1TNLhqHnDzacjRqs=";
  };
in
rustPlatform.buildRustPackage {
  pname = "quilt";
  version = "0.5.0-89f0e13";
  inherit src;

  cargoLock.lockFile = "${src}/Cargo.lock";

  cargoBuildFlags = [
    "-p"
    "quiltlang"
    "--bin"
    "quilt"
  ];
  # Each target language compiles its tree-sitter grammar from C, so build
  # only what Phib's sources quote: TypeScript hosts with ⟨str⟩ quotes.
  buildNoDefaultFeatures = true;
  buildFeatures = [
    "parse"
    "text"
    "typescript"
  ];

  # Quilt's own CI runs its tests.
  doCheck = false;

  meta = {
    description = "Quilt, a polyglot metaprogramming language";
    homepage = "https://github.com/QuiltLang/quilt";
    mainProgram = "quilt";
  };
}
