{
  inputs = {
    nixpkgs.url = "nixpkgs/nixos-25.05";
    flakelight = {
      url = "github:nix-community/flakelight";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    mill-scale = {
      url = "git+https://codeberg.org/icewind/mill-scale.git";
      inputs.flakelight.follows = "flakelight";
    };
    steam-vent = {
      url = "git+https://codeberg.org/steam-vent/steam-vent.git";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flakelight.follows = "flakelight";
      inputs.mill-scale.follows = "mill-scale";
    };
  };
  outputs = {
    mill-scale,
    steam-vent,
    ...
  }:
    mill-scale ./. {
      packages = {
        proto-builder = {craneLib, ...}:
          craneLib.buildPackage {
            src = craneLib.cleanCargoSource (steam-vent + "/protobuf/build");
            doCheck = false;
            strictDeps = true;
          };
      };
    };
}
