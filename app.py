import base64
import csv
import hashlib
import io
import json
import os
import secrets
import sqlite3
import threading
import time
import webbrowser
from datetime import date, datetime
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 3000
CONFIDENCE_LIMIT = 70
BASE = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(BASE, "attendance.db")
FACE_DIR = os.path.join(BASE, "faces")
SESSIONS = set()

# Static files served from the same folder as app.py
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/script.js": ("script.js", "application/javascript; charset=utf-8"),
}

try:
    import cv2
    import numpy as np
    HAS_CV = hasattr(cv2, "face")
except Exception:
    HAS_CV = False


def db():
    con = sqlite3.connect(DB_FILE, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    os.makedirs(FACE_DIR, exist_ok=True)
    with db() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE IF NOT EXISTS students(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            roll TEXT UNIQUE NOT NULL, name TEXT NOT NULL, course TEXT DEFAULT '',
            marks REAL DEFAULT 0, assignments REAL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS attendance(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL, day TEXT NOT NULL, time TEXT NOT NULL,
            status TEXT DEFAULT 'Present', method TEXT DEFAULT 'Face',
            UNIQUE(student_id, day));
        """)


def get_setting(key):
    with db() as con:
        row = con.execute("SELECT v FROM settings WHERE k=?", (key,)).fetchone()
    return row["v"] if row else None


def set_setting(key, value):
    with db() as con:
        con.execute("INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)", (key, value))


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200000).hex()
    return salt + "$" + digest


def check_pw(pw, stored):
    salt = stored.split("$")[0]
    return secrets.compare_digest(hash_pw(pw, salt), stored)


recognizer = None
model_lock = threading.Lock()
detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml") if HAS_CV else None


def decode_image(data_url):
    raw = base64.b64decode(data_url.split(",", 1)[1])
    return cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)


def find_face(img):
    gray = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    faces = detector.detectMultiScale(gray, 1.2, 5, minSize=(80, 80))
    if len(faces) == 0:
        return None
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    return cv2.resize(gray[y:y + h, x:x + w], (200, 200))


def train_model():
    global recognizer
    if not HAS_CV:
        return
    images, labels = [], []
    for name in os.listdir(FACE_DIR):
        if name.endswith(".png"):
            img = cv2.imread(os.path.join(FACE_DIR, name), 0)
            if img is not None:
                images.append(img)
                labels.append(int(name.split("_")[0]))
    with model_lock:
        if not images:
            recognizer = None
            return
        model = cv2.face.LBPHFaceRecognizer_create()
        model.train(images, np.array(labels))
        recognizer = model


def face_count(student_id):
    return len([f for f in os.listdir(FACE_DIR) if f.startswith(str(student_id) + "_")])


def mark_present(con, student_id, method="Face", day=None):
    day = day or date.today().isoformat()
    try:
        con.execute("INSERT INTO attendance(student_id,day,time,status,method) VALUES(?,?,?,?,?)",
                    (student_id, day, datetime.now().strftime("%H:%M:%S"), "Present", method))
        return True
    except sqlite3.IntegrityError:
        return False


def predict(total_days, pct, score, recent):
    if total_days < 3:
        return "Not enough data", "Needs at least 3 class days of attendance to predict."
    if score >= 75 and pct >= 75:
        return "High Performing", "Excellent! Try peer mentoring or an advanced project."
    if score < 55 or pct < 65:
        tip = "Meet a mentor this week."
        if pct < 75:
            tip += " Attendance is below 75%, so attend every class."
        if recent < pct:
            tip += " Recent attendance is dropping."
        return "At-Risk", tip
    return "Average", "Steady progress. Better attendance and assignments can lift you to the top band."


def student_stats(con):
    total = con.execute("SELECT COUNT(DISTINCT day) FROM attendance").fetchone()[0]
    last5 = [r[0] for r in con.execute("SELECT DISTINCT day FROM attendance ORDER BY day DESC LIMIT 5")]
    result = []
    for s in con.execute("SELECT * FROM students ORDER BY roll").fetchall():
        present = con.execute("SELECT COUNT(*) FROM attendance WHERE student_id=?", (s["id"],)).fetchone()[0]
        pct = round(present * 100 / total, 1) if total else 0.0
        recent = 0.0
        if last5:
            marks = ",".join("?" * len(last5))
            hit = con.execute(f"SELECT COUNT(*) FROM attendance WHERE student_id=? AND day IN ({marks})",
                              [s["id"]] + last5).fetchone()[0]
            recent = round(hit * 100 / len(last5), 1)
        score = round(0.5 * pct + 0.3 * s["marks"] + 0.2 * s["assignments"], 1)
        label, tip = predict(total, pct, score, recent)
        result.append({"id": s["id"], "roll": s["roll"], "name": s["name"], "course": s["course"],
                       "marks": s["marks"], "assignments": s["assignments"], "present": present,
                       "pct": pct, "recent": recent, "score": score, "label": label, "tip": tip,
                       "faces": face_count(s["id"])})
    return total, result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, data, ctype="application/json", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def reply(self, obj, code=200, headers=None):
        self.send(code, json.dumps(obj).encode(), headers=headers)

    def is_admin(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        return "sid" in cookie and cookie["sid"].value in SESSIONS

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = url.path

        if path in STATIC:
            filename, ctype = STATIC[path]
            try:
                with open(os.path.join(BASE, filename), "rb") as f:
                    return self.send(200, f.read(), ctype)
            except FileNotFoundError:
                return self.send(404, f"{filename} not found next to app.py".encode(), "text/plain")
        if path == "/api/status":
            return self.reply({"has_pw": get_setting("admin_pw") is not None, "admin": self.is_admin(),
                               "face": HAS_CV, "trained": recognizer is not None})
        if path == "/api/me":
            roll = q.get("roll", [""])[0].strip().lower()
            with db() as con:
                total, rows = student_stats(con)
            for s in rows:
                if s["roll"].lower() == roll:
                    return self.reply({"ok": True, "name": s["name"], "pct": s["pct"], "present": s["present"],
                                       "days": total, "label": s["label"], "tip": s["tip"]})
            return self.reply({"ok": False, "msg": "Roll number not found."})

        if not self.is_admin():
            return self.reply({"error": "login"}, 401)

        if path == "/api/students":
            with db() as con:
                return self.reply(student_stats(con)[1])
        if path == "/api/records":
            day = q.get("day", [""])[0]
            sql = ("SELECT a.id,s.roll,s.name,a.day,a.time,a.status,a.method FROM attendance a "
                   "JOIN students s ON s.id=a.student_id")
            with db() as con:
                if day:
                    rows = con.execute(sql + " WHERE a.day=? ORDER BY a.time", (day,)).fetchall()
                else:
                    rows = con.execute(sql + " ORDER BY a.day DESC, a.time DESC LIMIT 300").fetchall()
            return self.reply([dict(r) for r in rows])
        if path == "/api/analysis":
            with db() as con:
                total, rows = student_stats(con)
                today = con.execute("SELECT COUNT(*) FROM attendance WHERE day=?",
                                    (date.today().isoformat(),)).fetchone()[0]
                daily = con.execute("SELECT day, COUNT(*) c FROM attendance GROUP BY day "
                                    "ORDER BY day DESC LIMIT 14").fetchall()
            risk = {}
            for s in rows:
                risk[s["label"]] = risk.get(s["label"], 0) + 1
            avg = round(sum(s["pct"] for s in rows) / len(rows), 1) if rows else 0
            return self.reply({"students": len(rows), "today": today, "days": total, "avg": avg,
                               "daily": [{"day": d["day"], "count": d["c"]} for d in reversed(daily)],
                               "risk": risk,
                               "low": [s for s in rows if s["pct"] < 75 and total > 0]})
        if path == "/api/export":
            out = io.StringIO()
            writer = csv.writer(out)
            writer.writerow(["Roll", "Name", "Date", "Time", "Status", "Method"])
            with db() as con:
                for r in con.execute("SELECT s.roll,s.name,a.day,a.time,a.status,a.method FROM attendance a "
                                     "JOIN students s ON s.id=a.student_id ORDER BY a.day DESC"):
                    writer.writerow(list(r))
            return self.send(200, out.getvalue().encode(), "text/csv",
                             {"Content-Disposition": "attachment; filename=attendance.csv"})
        self.reply({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            size = int(self.headers.get("Content-Length", 0))
            d = json.loads(self.rfile.read(size) or b"{}")
        except Exception:
            return self.reply({"error": "bad request"}, 400)

        if path == "/api/setup":
            pw = str(d.get("password", ""))
            if get_setting("admin_pw") is not None:
                return self.reply({"ok": False, "msg": "Admin password already exists."})
            if len(pw) < 6:
                return self.reply({"ok": False, "msg": "Password must be at least 6 characters."})
            set_setting("admin_pw", hash_pw(pw))
            return self.login_ok()
        if path == "/api/login":
            stored = get_setting("admin_pw")
            if stored and check_pw(str(d.get("password", "")), stored):
                return self.login_ok()
            time.sleep(0.6)
            return self.reply({"ok": False, "msg": "Wrong password."})
        if path == "/api/logout":
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            if "sid" in cookie:
                SESSIONS.discard(cookie["sid"].value)
            return self.reply({"ok": True})
        if path == "/api/scan":
            return self.scan(d)

        if not self.is_admin():
            return self.reply({"error": "login"}, 401)

        with db() as con:
            if path == "/api/students/add":
                try:
                    con.execute("INSERT INTO students(roll,name,course,marks,assignments) VALUES(?,?,?,?,?)",
                                (str(d["roll"]).strip(), str(d["name"]).strip(), str(d.get("course", "")).strip(),
                                 float(d.get("marks") or 0), float(d.get("assignments") or 0)))
                    return self.reply({"ok": True})
                except sqlite3.IntegrityError:
                    return self.reply({"ok": False, "msg": "That roll number already exists."})
                except Exception:
                    return self.reply({"ok": False, "msg": "Please fill roll number and name."})
            if path == "/api/students/update":
                con.execute("UPDATE students SET marks=?, assignments=? WHERE id=?",
                            (float(d["marks"]), float(d["assignments"]), int(d["id"])))
                return self.reply({"ok": True})
            if path == "/api/students/delete":
                sid = int(d["id"])
                con.execute("DELETE FROM attendance WHERE student_id=?", (sid,))
                con.execute("DELETE FROM students WHERE id=?", (sid,))
                for f in os.listdir(FACE_DIR):
                    if f.startswith(str(sid) + "_"):
                        os.remove(os.path.join(FACE_DIR, f))
                threading.Thread(target=train_model, daemon=True).start()
                return self.reply({"ok": True})
            if path == "/api/records/add":
                added = mark_present(con, int(d["student_id"]), "Manual", d.get("day"))
                return self.reply({"ok": added, "msg": "" if added else "Already marked for that day."})
            if path == "/api/records/delete":
                con.execute("DELETE FROM attendance WHERE id=?", (int(d["id"]),))
                return self.reply({"ok": True})
            if path == "/api/password":
                if not check_pw(str(d.get("old", "")), get_setting("admin_pw")):
                    return self.reply({"ok": False, "msg": "Current password is wrong."})
                if len(str(d.get("new", ""))) < 6:
                    return self.reply({"ok": False, "msg": "New password needs 6+ characters."})
                set_setting("admin_pw", hash_pw(str(d["new"])))
                return self.reply({"ok": True, "msg": "Password changed."})
        if path == "/api/enroll":
            return self.enroll(d)
        self.reply({"error": "not found"}, 404)

    def login_ok(self):
        sid = secrets.token_hex(24)
        SESSIONS.add(sid)
        self.reply({"ok": True}, headers={"Set-Cookie": f"sid={sid}; Path=/; HttpOnly; SameSite=Strict"})

    def scan(self, d):
        if not HAS_CV:
            return self.reply({"ok": False, "msg": "Install opencv-contrib-python + numpy to use face recognition."})
        if recognizer is None:
            return self.reply({"ok": False, "msg": "No faces enrolled yet. Ask the admin to enroll students."})
        try:
            face = find_face(decode_image(d["image"]))
        except Exception:
            return self.reply({"ok": False, "msg": "Could not read camera frame."})
        if face is None:
            return self.reply({"ok": False, "msg": "No face found. Look at the camera."})
        with model_lock:
            label, distance = recognizer.predict(face)
        if distance > CONFIDENCE_LIMIT:
            return self.reply({"ok": False, "msg": "Face not recognised. Try better lighting."})
        with db() as con:
            student = con.execute("SELECT * FROM students WHERE id=?", (label,)).fetchone()
            if not student:
                return self.reply({"ok": False, "msg": "Unknown student."})
            new = mark_present(con, label, "Face")
        self.reply({"ok": True, "name": student["name"], "roll": student["roll"], "new": new,
                    "match": round(max(0, 100 - distance), 1)})

    def enroll(self, d):
        if not HAS_CV:
            return self.reply({"ok": False, "msg": "Install opencv-contrib-python + numpy first."})
        saved = 0
        base = int(time.time() * 1000) % 10**9
        for i, image in enumerate(d.get("images", [])):
            try:
                face = find_face(decode_image(image))
            except Exception:
                face = None
            if face is not None:
                cv2.imwrite(os.path.join(FACE_DIR, f"{int(d['id'])}_{base + i}.png"), face)
                saved += 1
        if saved < 3:
            return self.reply({"ok": False, "msg": "Face not clear. Use good light and face the camera."})
        train_model()
        self.reply({"ok": True, "msg": f"Saved {saved} face samples."})


if __name__ == "__main__":
    init_db()
    if HAS_CV:
        train_model()
    else:
        print("NOTE: face recognition is off. Run:  pip install opencv-contrib-python numpy")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"\n  SmartAttend AI is running ->  {url}\n  Press Ctrl + C to stop.\n")
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")