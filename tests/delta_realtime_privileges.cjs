'use strict';
// Runs the exact release RLS guard as a non-owner, non-superuser. Stock
// PostgreSQL/PGlite do not contain Supabase's supautils.policy_grants hook:
// policy DDL is deliberately still denied here, never simulated as permitted.
// The normal transport/release suites separately exercise all real policies.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const transport=read('docs/sentlog-delta-transport-prototype.sql');
const guard=transport.match(/DO \$sentlog_delta_realtime_rls\$[\s\S]*?END \$sentlog_delta_realtime_rls\$;/)?.[0];
const policy=transport.match(/CREATE POLICY sentlog_delta_receive_own ON realtime\.messages[\s\S]*?;/)?.[0];
assert(guard&&policy,'the exact production RLS guard and receive policy must be present');
assert(! /\bALTER\s+TABLE\s+(?:ONLY\s+)?realtime\.messages\b/i.test(transport),'transport must not ALTER a platform-owned table');
const sql=`BEGIN;
CREATE ROLE sentlog_test_realtime_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE sentlog_test_realtime_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
GRANT USAGE,CREATE ON SCHEMA realtime TO sentlog_test_realtime_owner;
GRANT USAGE ON SCHEMA realtime TO sentlog_test_realtime_migrator;
ALTER TABLE realtime.messages OWNER TO sentlog_test_realtime_owner;
CREATE TEMP TABLE realtime_privilege_checks(label text NOT NULL);
GRANT SELECT,INSERT ON pg_temp.realtime_privilege_checks TO sentlog_test_realtime_migrator;
CREATE FUNCTION pg_temp.realtime_check(ok boolean,label text) RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $check$
BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
 INSERT INTO pg_temp.realtime_privilege_checks VALUES(label);RETURN 'PASS '||label;
END $check$;
CREATE FUNCTION pg_temp.realtime_fails(statement text,expected_state text,marker text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fails$
BEGIN
 EXECUTE statement;RETURN false;
EXCEPTION WHEN OTHERS THEN
 IF SQLSTATE<>expected_state OR position(marker in SQLERRM)=0 THEN
  RAISE EXCEPTION 'Expected % / %, got %: %',expected_state,marker,SQLSTATE,SQLERRM;
 END IF;
 RETURN true;
END $fails$;
SET LOCAL ROLE sentlog_test_realtime_migrator;
SELECT pg_temp.realtime_check(
 (SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user) AND
 NOT pg_has_role(current_user,'sentlog_test_realtime_owner','USAGE') AND
 (SELECT relowner='sentlog_test_realtime_owner'::regrole AND relrowsecurity FROM pg_class WHERE oid='realtime.messages'::regclass),
 'fixture has managed RLS enabled and a migration role without owner, superuser or bypass privileges') AS result;
SELECT pg_temp.realtime_check(pg_temp.realtime_fails(
 'ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY','42501','must be owner of table messages'),
 'the old unconditional ALTER reproduces the production ownership error') AS result;
${guard}
SELECT pg_temp.realtime_check(
 (SELECT relrowsecurity AND relowner='sentlog_test_realtime_owner'::regrole FROM pg_class WHERE oid='realtime.messages'::regclass),
 'the exact production catalog guard succeeds without changing owner or managed RLS') AS result;
SELECT pg_temp.realtime_check(pg_temp.realtime_fails($policy_test$${policy}$policy_test$,'42501','must be owner of table messages'),
 'stock PostgreSQL still refuses policy DDL without the platform delegated policy grant') AS result;
RESET ROLE;
ALTER TABLE realtime.messages DISABLE ROW LEVEL SECURITY;
SET LOCAL ROLE sentlog_test_realtime_migrator;
SELECT pg_temp.realtime_check(pg_temp.realtime_fails($guard_test$${guard}$guard_test$,'55000','DELTA_REALTIME_RLS_REQUIRED'),
 'disabled managed RLS stops the release rather than being enabled or ignored') AS result;
SELECT pg_temp.realtime_check(
 (SELECT NOT relrowsecurity FROM pg_class WHERE oid='realtime.messages'::regclass),
 'the failed catalog guard performs no corrective DDL') AS result;
RESET ROLE;
ALTER TABLE realtime.messages RENAME TO test_hidden_realtime_messages;
SET LOCAL ROLE sentlog_test_realtime_migrator;
SELECT pg_temp.realtime_check(pg_temp.realtime_fails($guard_test$${guard}$guard_test$,'55000','DELTA_REALTIME_RLS_REQUIRED'),
 'a missing managed messages table also stops the exact release guard') AS result;
RESET ROLE;
SELECT 'PASS realtime privileges: '||count(*)||' non-owner checks; delegated policy DDL is not emulated' AS result FROM pg_temp.realtime_privilege_checks;
ROLLBACK;
`;
if(process.argv.includes('--sql'))process.stdout.write(sql);
else (async()=>{
 const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
 try{
  for(const file of ['tests/delta_schema_fixture.sql','tests/delta_transport_fixture.sql'])await db.exec(read(file));
  for(const result of await db.exec(sql))for(const row of result.rows||[])if(row.result)console.log(row.result);
  const after=await db.query("SELECT relrowsecurity,relowner=current_user::regrole AS original_owner FROM pg_class WHERE oid='realtime.messages'::regclass");
  assert.equal(after.rows[0].relrowsecurity,true);assert.equal(after.rows[0].original_owner,true);
 }finally{await db.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
