{
  pkgs ? import <nixpkgs> { },
}:
with pkgs;
mkShell rec {
  buildInputs = [
    nodejs_22 # Follow the vscode node version requirement
  ];
  LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath buildInputs;
  LANG = "C.UTF-8";
  shellHook = with pkgs; '''';
}
