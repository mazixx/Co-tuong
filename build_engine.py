import ast
import copy
from pathlib import Path


SOURCE = Path("co_tuong_original.txt")
OUTPUT = Path("engine.py")


def is_graphics_start(node):
    return (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Attribute)
        and isinstance(node.value.func.value, ast.Name)
        and node.value.func.value.id == "pygame"
        and node.value.func.attr == "init"
    )


def main():
    if not SOURCE.is_file():
        raise SystemExit("Thiếu co_tuong_original.txt.")

    tree = ast.parse(
        SOURCE.read_text(encoding="utf-8-sig"),
        filename=str(SOURCE),
    )

    kept = []
    found_graphics = False

    for original in tree.body:
        if is_graphics_start(original):
            found_graphics = True
            break

        node = copy.deepcopy(original)

        if isinstance(node, ast.Import):
            node.names = [
                alias
                for alias in node.names
                if alias.name not in {
                    "pygame", "threading", "queue"
                }
            ]

            if node.names:
                kept.append(node)

        elif isinstance(node, ast.ImportFrom):
            if not (node.module or "").startswith("pygame"):
                kept.append(node)

        else:
            kept.append(node)

    if not found_graphics:
        raise SystemExit(
            "Không tìm thấy pygame.init(); "
            "file nguồn không đúng cấu trúc đã cung cấp."
        )

    definitions = {
        node.name
        for node in kept
        if isinstance(node, (ast.FunctionDef, ast.ClassDef))
    }

    required = {
        "initial_board",
        "legal_moves",
        "position_key",
        "make_move",
        "evaluate",
        "Engine",
        "grade_move",
    }

    if not required.issubset(definitions):
        raise SystemExit("Thiếu hàm luật cờ hoặc AI.")

    output_tree = ast.Module(body=kept, type_ignores=[])
    ast.fix_missing_locations(output_tree)

    references = {
        node.id
        for node in ast.walk(output_tree)
        if isinstance(node, ast.Name)
    }

    if references & {"pygame", "threading", "queue"}:
        raise SystemExit("Engine còn phụ thuộc giao diện desktop.")

    result = (
        "# Tạo tự động từ co_tuong_original.txt\n"
        "# Luật cờ và AI, không phụ thuộc Pygame.\n\n"
        + ast.unparse(output_tree)
        + "\n"
    )

    compile(result, str(OUTPUT), "exec")
    OUTPUT.write_text(result, encoding="utf-8")

    print("Đã tạo engine.py thành công.")


if __name__ == "__main__":
    main()
