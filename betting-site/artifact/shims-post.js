/* ===== 저장소를 시트 대신 아티팩트 DB(엔진)로 바꾸는 부분 ===== */
Table = function (name) { this.name = name; this.cols = SHEETS[name]; this.sheet = { deleteRows: function () {} }; };
Table.prototype.all = function () { return ENG.rows(this.name); };
Table.prototype.find = function (fn) { return this.all().filter(fn)[0] || null; };
Table.prototype.where = function (fn) { return this.all().filter(fn); };
Table.prototype.insert = function (o) { if (this.cols[0] === 'id') o.id = ENG.nextId(this.name); ENG.add(this.name, o); return o; };
Table.prototype.save = function (o) { ENG.touch(this.name, o); };
Table.prototype.remove = function (o) { ENG.del(this.name, o); };
Table.prototype.removeWhere = function (fn) { var self = this; this.where(fn).slice().forEach(function (o) { self.remove(o); }); };
groupKey = function (code) { return 'g_' + String(code).toLowerCase(); };   // 방은 하나뿐이라 코드가 그대로 방 번호
hashPin = function (pin, salt) { return 'h:' + pin + ':' + salt; };   // 로그인은 계정 번호로 자동. PIN 은 형식만 맞춤
adminOnly = function () { if (!ENG.isOwner()) fail(403, '관리자만 사용할 수 있습니다. 아티팩트 소유자 계정으로 열어주십시오.'); };
CFG.APPROVAL = false;   // 접근은 공유(초대)로 관리하므로 가입 승인은 끔
__mem.SCHEMA_V = SCHEMA_V;
return { handle: handle, reset: function () { HOLDING = false; }, CFG: CFG, GAMES: GAMES, tbl: tbl, SHEETS: SHEETS, ROUTES: ROUTES };
