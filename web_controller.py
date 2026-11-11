import json
import random
import time
from collections import Counter

import engine as e


GAME = None


class NoCancel:
    def is_set(self):
        return False


class WebGame:
    def __init__(self, level=0):
        if type(level) is not int or not 0 <= level < len(e.LEVELS):
            raise ValueError("Cấp độ không hợp lệ.")

        self.level = level
        self.theme = random.randrange(len(e.THEMES))

        self.board = e.initial_board()
        self.turn = e.RED
        self.remaining = {
            e.RED: float(e.TOTAL_TIME),
            e.BLACK: float(e.TOTAL_TIME),
        }

        self.finished = False
        self.paused = False
        self.pause_started = None

        self.history = []
        self.last_move = None
        self.undo_stack = []
        self.undo_accepted = 0
        self.undo_requested = set()
        self.draw_requested = set()

        self.hint = None
        self.hint_requested = False
        self.hint_status = "Gợi ý tự xuất hiện sau 30 giây suy nghĩ."
        self.pending_grade = None

        self.message = "Lượt của bạn — quân Đỏ."
        self.note = (
            "Mỗi bên 10 phút. Đi lại tối đa 2 lần được chấp nhận; "
            "không hoàn lại thời gian."
        )
        self.ai_info = "AI chưa phân tích."

        self.counts = Counter()
        self.counts[e.position_key(self.board, self.turn)] = 1

        self.refresh_moves()

        now = time.perf_counter()
        self.last_clock = now
        self.turn_started = now

    def refresh_moves(self):
        self.basic_moves = e.legal_moves(self.board, self.turn)
        self.moves = e.legal_moves(
            self.board, self.turn, self.counts
        )
        self.blocked_moves = set(self.basic_moves) - set(self.moves)
        self.checked = e.in_check(self.board, self.turn)

    def finish(self, message):
        self.finished = True
        self.message = message
        self.pending_grade = None

    def charge_clock(self):
        now = time.perf_counter()

        if self.paused or self.finished:
            self.last_clock = now
            return

        elapsed = max(0.0, now - self.last_clock)
        self.last_clock = now

        self.remaining[self.turn] = max(
            0.0, self.remaining[self.turn] - elapsed
        )

        if self.remaining[self.turn] <= 0:
            self.finish(
                "Bạn hết giờ — máy thắng."
                if self.turn == e.RED
                else "Máy hết giờ — bạn thắng!"
            )

    def set_pause(self, value):
        value = bool(value)

        if self.finished or value == self.paused:
            return

        if value:
            self.charge_clock()

            if self.finished:
                return

            self.paused = True
            self.pause_started = time.perf_counter()
            self.saved_message = self.message
            self.message = "Ván đấu đang tạm dừng."

            if self.hint is None:
                self.hint_requested = False

        else:
            now = time.perf_counter()
            self.turn_started += now - self.pause_started
            self.last_clock = now

            self.paused = False
            self.pause_started = None
            self.message = self.saved_message

    def save_position(self):
        return {
            "board": [row[:] for row in self.board],
            "history": [entry.copy() for entry in self.history],
            "counts": self.counts.copy(),
            "last_move": self.last_move,
        }

    def play_move(self, move, ai_depth=0):
        self.charge_clock()

        if self.finished or self.paused:
            raise ValueError("Ván đã kết thúc hoặc đang tạm dừng.")

        move = tuple(move)

        if move not in self.moves:
            raise ValueError("Nước đi không hợp lệ.")

        side = self.turn
        name = e.move_name(self.board, move)

        if side == e.RED:
            self.undo_stack.append(self.save_position())

            self.pending_grade = (
                [row[:] for row in self.board],
                move,
                self.counts.copy(),
                len(self.history),
            )

        e.make_move(self.board, move)

        self.history.append({
            "side": side,
            "name": name,
            "comment": (
                "Đang chấm nước..."
                if side == e.RED
                else f"AI chọn · độ sâu hoàn thành {ai_depth}"
            ),
        })

        self.last_move = move
        self.hint = None
        self.hint_requested = False
        self.hint_status = "Gợi ý tự xuất hiện sau 30 giây suy nghĩ."

        self.turn = -side

        if self.turn == e.RED:
            self.pending_grade = None

        self.counts[e.position_key(self.board, self.turn)] += 1

        now = time.perf_counter()
        self.last_clock = now
        self.turn_started = now

        self.refresh_moves()

        if not self.moves:
            self.history[-1]["comment"] = "Nước kết thúc ván."

            reason = (
                "chỉ còn nước bị cấm lặp lần thứ ba"
                if self.basic_moves
                else "hết nước hợp lệ"
            )

            self.finish(
                f"Bạn thắng! Đen {reason}."
                if self.turn == e.BLACK
                else f"Máy thắng! Đỏ {reason}."
            )
            return

        self.message = (
            "Đen bị chiếu — máy đang nghĩ..."
            if self.turn == e.BLACK and self.checked
            else "Máy đang suy nghĩ..."
            if self.turn == e.BLACK
            else "Bạn đang bị chiếu!"
            if self.checked
            else "Lượt của bạn — quân Đỏ."
        )

    def run_ai(self):
        self.charge_clock()

        if self.finished or self.paused or self.turn != e.BLACK:
            return

        cancel = NoCancel()

        if self.pending_grade is not None:
            before, move, counts, index = self.pending_grade
            self.pending_grade = None

            comment = e.grade_move(
                [row[:] for row in before],
                move,
                counts,
                cancel,
            )

            if index < len(self.history):
                self.history[index]["comment"] = comment

            self.charge_clock()

            if self.finished:
                return

        _, depth_limit, seconds = e.LEVELS[self.level]
        budget = min(seconds, self.remaining[e.BLACK])

        search = e.Engine(budget, cancel)

        move, score, depth, _ = search.search(
            [row[:] for row in self.board],
            e.BLACK,
            depth_limit,
            self.counts,
        )

        self.charge_clock()

        if self.finished:
            return

        if score is None:
            self.ai_info = (
                f"AI: d{depth} · {search.nodes:,} nút."
            )
        elif abs(score) > e.MATE // 2:
            self.ai_info = "Engine thấy biến thắng/thua quyết định."
        else:
            self.ai_info = (
                f"Phân tích gần nhất: Đỏ {-score / 100:+.1f}"
                f" · d{depth} · {search.nodes:,} nút"
            )

        if move not in self.moves:
            self.finish("Engine không trả về nước hợp lệ.")
            return

        self.play_move(move, ai_depth=depth)

    def run_hint(self):
        self.charge_clock()

        if (
            self.finished or self.paused
            or self.turn != e.RED or self.hint_requested
        ):
            return

        if time.perf_counter() - self.turn_started < e.HINT_AFTER:
            return

        self.hint_requested = True

        search = e.Engine(
            min(3.0, self.remaining[e.RED]),
            NoCancel(),
        )

        move, _, depth, _ = search.search(
            [row[:] for row in self.board],
            e.RED,
            5,
            self.counts,
        )

        self.charge_clock()

        if self.finished:
            return

        if move in self.moves and depth > 0:
            self.hint = move
            self.hint_status = (
                f"Gợi ý: {e.move_name(self.board, move)}"
                f" · độ sâu {depth}. Xem mũi tên xanh."
            )
        else:
            self.hint_status = (
                "Chưa đủ thời gian để phân tích gợi ý lượt này."
            )

    def can_undo(self):
        return (
            not self.finished
            and not self.paused
            and self.turn == e.RED
            and bool(self.undo_stack)
            and len(self.history) >= 2
            and self.undo_accepted < e.MAX_UNDO
            and e.position_key(
                self.board, self.turn
            ) not in self.undo_requested
        )

    def request_undo(self):
        self.charge_clock()

        if not self.can_undo():
            return

        key = e.position_key(self.board, self.turn)
        self.undo_requested.add(key)

        if self.checked:
            self.note = "Máy từ chối đi lại: bạn đang bị chiếu."
            return

        if e.evaluate(self.board, e.BLACK) > 180:
            self.note = "Máy từ chối đi lại: đang có lợi thế rõ rệt."
            return

        if self.remaining[e.RED] < 20:
            self.note = "Máy từ chối đi lại: bạn còn quá ít thời gian."
            return

        saved = self.undo_stack.pop()

        self.board = [row[:] for row in saved["board"]]
        self.history = [entry.copy() for entry in saved["history"]]
        self.counts = saved["counts"].copy()
        self.last_move = saved["last_move"]

        self.turn = e.RED
        self.pending_grade = None
        self.hint = None
        self.hint_requested = False
        self.hint_status = "Gợi ý tự xuất hiện sau 30 giây suy nghĩ."

        self.undo_accepted += 1
        self.refresh_moves()

        now = time.perf_counter()
        self.last_clock = now
        self.turn_started = now

        self.message = "Máy đồng ý — bạn hãy chọn nước khác."
        self.note = (
            "Đã thu hồi một cặp nước. "
            f"Còn {e.MAX_UNDO - self.undo_accepted} lần; "
            "không hoàn lại thời gian."
        )
        self.ai_info = "Thế cờ đã được khôi phục."

    def offer_draw(self):
        self.charge_clock()

        if self.finished or self.paused or self.turn != e.RED:
            return

        key = e.position_key(self.board, self.turn)

        if key in self.draw_requested:
            self.note = "Bạn đã cầu hòa tại thế cờ này."
            return

        self.draw_requested.add(key)

        if len(self.history) < 12:
            self.note = "Máy từ chối cầu hòa: ván đấu còn quá sớm."
            return

        if (
            self.remaining[e.RED] < 30
            and self.remaining[e.BLACK] > 60
        ):
            self.note = "Máy từ chối: đang có lợi thế thời gian."
            return

        advantage = e.evaluate(self.board, e.BLACK)

        attackers = sum(
            abs(piece) in (e.HORSE, e.ROOK, e.CANNON, e.PAWN)
            for row in self.board
            for piece in row
        )

        accept = (
            advantage < -180
            or (abs(advantage) <= 100 and attackers <= 6)
            or (
                self.remaining[e.BLACK] < 45
                and advantage < 100
            )
        )

        if accept:
            self.finish("Hòa! Máy đồng ý đề nghị cầu hòa.")
            self.note = "Đánh giá dựa trên thế cờ và thời gian."
        else:
            self.note = "Máy từ chối cầu hòa: muốn tiếp tục thi đấu."

    def snapshot(self):
        self.charge_clock()

        reference = (
            self.pause_started
            if self.paused
            else time.perf_counter()
        )

        spent = max(0.0, reference - self.turn_started)

        return {
            "board": self.board,
            "turn": self.turn,
            "remaining": [
                self.remaining[e.RED],
                self.remaining[e.BLACK],
            ],
            "finished": self.finished,
            "paused": self.paused,
            "checked": self.checked,
            "king": (
                e.find_king(self.board, self.turn)
                if self.checked else None
            ),
            "moves": self.moves,
            "blocked": sorted(self.blocked_moves),
            "last": self.last_move,
            "hint": self.hint,
            "hint_due": (
                not self.finished
                and not self.paused
                and self.turn == e.RED
                and not self.hint_requested
                and spent >= e.HINT_AFTER
            ),
            "spent": spent,
            "hint_status": self.hint_status,
            "message": self.message,
            "note": self.note,
            "ai_info": self.ai_info,
            "history": self.history,
            "can_undo": self.can_undo(),
            "undo_left": e.MAX_UNDO - self.undo_accepted,
            "evaluation": e.evaluate(self.board, e.RED) / 100,
            "level": self.level,
            "theme": self.theme,
            "levels": e.LEVELS,
            "themes": e.THEMES,
            "han": e.HAN,
        }


def api(raw):
    global GAME

    request = json.loads(raw)
    operation = request.get("op")

    if operation == "new":
        GAME = WebGame(request.get("level", 0))

    else:
        if GAME is None:
            raise ValueError("Hãy tạo ván mới.")

        try:
            if operation == "tick":
                GAME.charge_clock()

            elif operation == "ai":
                GAME.run_ai()

            elif operation == "hint":
                GAME.run_hint()

            elif operation == "move":
                if GAME.turn != e.RED:
                    raise ValueError("Chưa đến lượt bạn.")

                move = request.get("move")

                if (
                    not isinstance(move, list)
                    or len(move) != 4
                    or any(type(value) is not int for value in move)
                ):
                    raise ValueError("Nước đi không hợp lệ.")

                GAME.play_move(move)

            elif operation == "pause":
                GAME.set_pause(request.get("value", True))

            elif operation == "undo":
                GAME.request_undo()

            elif operation == "draw":
                GAME.offer_draw()

            elif operation == "resign":
                GAME.charge_clock()

                if not GAME.finished and not GAME.paused:
                    GAME.finish("Bạn đã xin thua — máy thắng.")

            elif operation == "theme":
                choices = [
                    index for index in range(len(e.THEMES))
                    if index != GAME.theme
                ]
                GAME.theme = random.choice(choices)

            else:
                raise ValueError("Lệnh không hợp lệ.")

        except Exception:
            if operation in ("ai", "hint", "tick"):
                GAME.set_pause(True)
            raise

    return json.dumps(
        {"state": GAME.snapshot()},
        ensure_ascii=False,
    )
