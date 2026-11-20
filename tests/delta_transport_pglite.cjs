'use strict';
// No URL or credentials accepted: the database lives only in this process.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
  const db=new PGlite();
  try{
    for(const file of ['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql',
      // CI keeps the schema and baseline fixtures in the same database. Keep
      // their durable setup here too, so a prior enabled/archived head cannot
      // accidentally masquerade as an unactivated transport fixture.
      'docs/sentlog-delta-semantic-validation-prototype.sql','tests/delta_schema_assertions.sql',
      'tests/delta_schema_adversarial.sql','tests/delta_semantic_assertions.sql',
      'tests/delta_baseline_fixture.sql','docs/sentlog-delta-baseline-prototype.sql',
      'tests/delta_baseline_assertions.sql','tests/delta_transport_fixture.sql',
      'docs/sentlog-delta-transport-prototype.sql','tests/delta_transport_assertions.sql']){
      const sql=fs.readFileSync(path.resolve(__dirname,'..',file),'utf8').replace(/^\\set[^\n]*$/mg,'');
      for(const block of sql.split(/^(BEGIN;|ROLLBACK;|COMMIT;)$/m)){
        if(!block.trim())continue;
        for(const result of await db.exec(block))for(const row of result.rows||[])if(row.result)console.log(row.result);
      }
      console.log('PASS '+file);
    }
  }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
