'use strict';
const {PGlite}=require('@electric-sql/pglite'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const read=file=>fs.readFileSync(path.resolve(__dirname,'..',file),'utf8').replace(/^\\set[^\n]*$/mg,'');
(async()=>{const db=new PGlite();try{
  async function apply(file){for(const block of read(file).split(/^(BEGIN;|ROLLBACK;|COMMIT;)$/m))if(block.trim())
    for(const result of await db.exec(block))for(const row of result.rows||[])if(row.result)console.log(row.result);
    console.log('PASS '+file);}
  for(const f of ['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql',
    'docs/sentlog-delta-semantic-validation-prototype.sql','tests/delta_baseline_fixture.sql',
    'docs/sentlog-delta-baseline-prototype.sql','tests/delta_transport_fixture.sql',
    'docs/sentlog-delta-transport-prototype.sql','docs/sentlog-delta-atomic-groups-prototype.sql'])await apply(f);
  await assert.rejects(db.exec(read('docs/sentlog-delta-archive-compat-prototype.sql')),
    e=>e.code==='55000'&&/DELTA_ARCHIVE_PROTOCOL_REQUIRED/.test(e.message));
  await db.exec('ROLLBACK');console.log('PASS missing archive protocol prevents compatibility migration');
  for(const f of ['tests/delta_archive_fixture.sql','db/archive_v1.sql','tests/delta_archive_setup.sql',
    'docs/sentlog-delta-archive-compat-prototype.sql','tests/delta_archive_assertions.sql'])await apply(f);
}finally{await db.close();}})().catch(e=>{console.error({code:e.code,message:e.message,where:e.where});process.exitCode=1;});
