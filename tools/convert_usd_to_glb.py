import os
import sys
import bpy


def parse_args():
    """
    Blender passes script args after `--`.
    Expected:
      blender --background --python tools/convert_usd_to_glb.py -- <input.usd> <output.glb>
    """
    if "--" not in sys.argv:
        raise ValueError("Missing '--' separator. Provide input and output paths after '--'.")

    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) < 2:
        raise ValueError("Usage: ... -- <input.usd/usda/usdc/usdz> <output.glb>")

    input_path = os.path.abspath(args[0])
    output_path = os.path.abspath(args[1])
    return input_path, output_path


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_scene_file(input_path):
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input file not found: {input_path}")

    extension = os.path.splitext(input_path)[1].lower()

    if extension in [".usd", ".usda", ".usdc", ".usdz"]:
        # Blender's USD importer entry point.
        # Future extension: add import options from a JSON sidecar if needed.
        bpy.ops.wm.usd_import(filepath=input_path)
        return

    if extension == ".fbx":
        bpy.ops.import_scene.fbx(filepath=input_path)
        return

    raise ValueError(f"Unsupported input format for conversion: {extension}")


def export_glb(output_path):
    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format="GLB",
        export_apply=True,
    )


def main():
    input_path, output_path = parse_args()
    print(f"[MotionForge] Converting asset -> GLB\n  input:  {input_path}\n  output: {output_path}")

    reset_scene()
    import_scene_file(input_path)
    export_glb(output_path)

    print("[MotionForge] Conversion finished successfully.")


if __name__ == "__main__":
    main()
